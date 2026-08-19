// Generates vector embeddings through the provider named in the settings.
// Ollama (local, free, no rate limits) stays the default; the OpenAI-compatible
// and Gemini providers exist for hosted endpoints.

import axios from "axios";
import { logger } from "../utils/logger";
import { EmbeddingConfig, EmbeddingProvider, getEmbeddingConfig } from "../utils/settings";

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 60000;

/**
 * How many texts go out at a time, and how long to rest between batches.
 *
 * Ollama serializes on a local CPU, so it keeps the small batch and the pause
 * that leaves a low-end machine responsive. A hosted provider takes the whole
 * batch in one request and only loses time to the pause.
 */
const BATCHING: Record<EmbeddingProvider, { size: number; delayMs: number }> = {
  "ollama": { size: 3, delayMs: 500 },
  "openai-compatible": { size: 64, delayMs: 0 },
  // Gemini meters every text inside a batch, not the call carrying them, so a
  // 100-text batch spends a whole free-tier minute at once and leaves the pacer
  // below nothing to spread. A smaller batch also loses less to a refusal.
  "gemini": { size: 25, delayMs: 0 },
};

/**
 * What a provider accepts per minute, counted the way that provider counts.
 *
 * Gemini charges each text in a batchEmbedContents call against the request
 * quota, so a re-index that looks like two HTTP calls is really two hundred
 * requests — which is how 275 chunks exhausted a 100/minute ceiling three
 * seconds in. These are the free tier's figures; a paid key is worth far more,
 * so both are overridable rather than holding every key at the lowest tier.
 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

const RATE_LIMITS: Record<EmbeddingProvider, { rpm: number; tpm: number }> = {
  // Local, and the only thing metering it is the CPU.
  "ollama": { rpm: NO_LIMIT, tpm: NO_LIMIT },
  // Far too host-dependent to guess; the 429 handler covers it after the fact.
  "openai-compatible": { rpm: NO_LIMIT, tpm: NO_LIMIT },
  "gemini": { rpm: 100, tpm: 30_000 },
};

function rateLimitFor(provider: EmbeddingProvider) {
  const defaults = RATE_LIMITS[provider] || RATE_LIMITS.ollama;
  return {
    rpm: Number(process.env.EMBEDDING_RPM) || defaults.rpm,
    tpm: Number(process.env.EMBEDDING_TPM) || defaults.tpm,
  };
}

/**
 * A provider returned a vector the index cannot hold.
 *
 * Reshaping it — truncating or zero-padding — would leave the table holding
 * vectors of different provenance whose L2 distances no longer compare, so this
 * is raised instead, and it is never retried.
 */
export class EmbeddingDimensionError extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Requests and tokens already spent inside the trailing minute. */
const spent: { at: number; requests: number; tokens: number }[] = [];

/** Rough by necessity: providers bill tokens and all we hold is characters. */
function estimateTokens(texts: string[]): number {
  // Deliberately over-counts. Pacing under the real figure is what gets refused.
  return texts.reduce((total, text) => total + Math.ceil(text.length / 3.5), 0);
}

/**
 * Hold a call back until it fits inside the provider's minute.
 *
 * Waiting only once a 429 arrives throws away whatever that call had already
 * computed, and against a daily-capped key the waste is permanent — the refused
 * requests still count. So the window is tracked here and the call waits before
 * it is made rather than after it is rejected.
 */
async function reserveQuota(provider: EmbeddingProvider, texts: string[]): Promise<void> {
  const { rpm, tpm } = rateLimitFor(provider);
  if (rpm === NO_LIMIT && tpm === NO_LIMIT) return;

  const requests = texts.length;
  const tokens = estimateTokens(texts);

  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].at >= 60_000) spent.shift();

    const usedRequests = spent.reduce((n, s) => n + s.requests, 0);
    const usedTokens = spent.reduce((n, s) => n + s.tokens, 0);

    // Nothing awaits between this test and the push, so two callers pacing at
    // once cannot both read the same free capacity and claim it.
    if (usedRequests + requests <= rpm && usedTokens + tokens <= tpm) {
      spent.push({ at: now, requests, tokens });
      return;
    }

    // A single call larger than the entire minute can never come to fit, and
    // holding it forever is worse than letting the provider answer for itself.
    if (spent.length === 0) {
      logger.warn(
        `[ArcRift] One ${provider} batch (${requests} texts, ~${tokens} tokens) exceeds the ` +
        "per-minute allowance on its own — sending it and letting the provider decide."
      );
      spent.push({ at: now, requests, tokens });
      return;
    }

    const waitMs = spent[0].at + 60_000 - now + 50;
    logger.debug(
      `[ArcRift] Pacing ${provider}: ${usedRequests}/${rpm} req, ${usedTokens}/${tpm} tok used — ` +
      `waiting ${Math.ceil(waitMs / 1000)}s.`
    );
    await sleep(waitMs);
  }
}

/** What a refusal actually said, for providers that say anything useful. */
interface RateLimitInfo {
  retryAfterMs: number;
  quota: string;
  /** A day's allowance does not come back before the day does. */
  daily: boolean;
}

function rateLimitInfo(err: any): RateLimitInfo | null {
  const status = err?.response?.status;
  // 503 is overloaded rather than over quota, but backing off is the same answer.
  if (status !== 429 && status !== 503) return null;

  let retryAfterMs = 0;
  let quota = "";

  // Gemini attaches google.rpc.QuotaFailure and google.rpc.RetryInfo, which name
  // the exhausted quota and how long it wants. axios flattens the message to
  // "Request failed with status code 429" and the rest is lost unless read here.
  const details = err?.response?.data?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const type = String(detail?.["@type"] || "");
      if (type.endsWith("RetryInfo")) {
        const seconds = parseFloat(String(detail?.retryDelay ?? ""));
        if (Number.isFinite(seconds)) retryAfterMs = Math.ceil(seconds * 1000);
      }
      if (type.endsWith("QuotaFailure")) {
        const violation = Array.isArray(detail?.violations) ? detail.violations[0] : null;
        quota = violation?.quotaId || violation?.quotaMetric || "";
      }
    }
  }

  // OpenAI-compatible hosts carry it in the header instead.
  const header = err?.response?.headers?.["retry-after"];
  if (!retryAfterMs && header !== undefined) {
    const seconds = parseFloat(String(header));
    if (Number.isFinite(seconds)) retryAfterMs = Math.ceil(seconds * 1000);
  }

  return { retryAfterMs, quota, daily: /per_?day|daily/i.test(quota) };
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Proxy for calls that leave the machine, read from the environment only.
 * Defaulting to some local proxy port would route every hosted request through
 * a port that may not be listening, and the failure reads as the API being down.
 */
function getProxyConfig(targetUrl: string) {
  if (isLocalUrl(targetUrl)) return undefined;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    logger.warn(`[ArcRift] Ignoring unparseable proxy URL: ${proxyUrl}`);
    return undefined;
  }
}

function requestConfig(url: string, headers: Record<string, string>) {
  const proxy = getProxyConfig(url);
  return {
    headers,
    timeout: REQUEST_TIMEOUT,
    ...(proxy ? { proxy } : {}),
  };
}

/** Reject anything the vec0 tables cannot store, naming what produced it. */
function checkDimension(vector: unknown, config: EmbeddingConfig): number[] {
  if (!Array.isArray(vector)) {
    throw new EmbeddingDimensionError(
      `${config.provider} (${config.model}) returned no embedding vector.`
    );
  }
  if (vector.length !== config.dimension) {
    throw new EmbeddingDimensionError(
      `${config.provider} (${config.model}) returned a ${vector.length}-dimension embedding, ` +
      `expected ${config.dimension}. Use a model of the index's width, or rebuild the index.`
    );
  }
  return vector;
}

// ── Ollama ─────────────────────────────────────────────────────────────
async function embedWithOllama(
  text: string,
  task: "query" | "document",
  config: EmbeddingConfig
): Promise<number[]> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  // nomic-embed-text is trained with these prefixes and needs them for usable
  // scores. No other model is, so nothing else gets them.
  const prefix = config.model.includes("nomic-embed-text")
    ? (task === "query" ? "search_query: " : "search_document: ")
    : "";
  const prompt = `${prefix}${text}`;

  try {
    const response = await axios.post(
      `${baseUrl}/api/embeddings`,
      { model: config.model, prompt },
      { timeout: REQUEST_TIMEOUT }
    );
    if (Array.isArray(response.data?.embedding)) {
      return checkDimension(response.data.embedding, config);
    }
    throw new Error(`Ollama returned no embedding for model ${config.model}`);
  } catch (err: any) {
    if (err instanceof EmbeddingDimensionError) throw err;

    // Newer Ollama builds dropped /api/embeddings for /api/embed. Retrying
    // there keeps one install working across both daemon versions.
    try {
      const response = await axios.post(
        `${baseUrl}/api/embed`,
        { model: config.model, input: prompt },
        { timeout: REQUEST_TIMEOUT }
      );
      if (Array.isArray(response.data?.embeddings?.[0])) {
        return checkDimension(response.data.embeddings[0], config);
      }
    } catch (fallbackErr: any) {
      if (fallbackErr instanceof EmbeddingDimensionError) throw fallbackErr;
      // Report the original failure — the daemon most likely has neither route.
    }
    throw err;
  }
}

// ── OpenAI-compatible ──────────────────────────────────────────────────
async function embedWithOpenAI(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;

  const payload: Record<string, any> = { model: config.model, input: texts };
  // text-embedding-3 emits the requested width natively, which beats reshaping
  // whatever comes back.
  if (config.model.includes("text-embedding-3")) {
    payload.dimensions = config.dimension;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const response = await axios.post(url, payload, requestConfig(url, headers));

  const data = response.data?.data;
  if (!Array.isArray(data)) {
    throw new Error(`${config.provider} embeddings API returned no data array`);
  }

  // The API does not promise the results come back in the order they were sent.
  return [...data]
    .sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((entry: any) => checkDimension(entry?.embedding, config));
}

// ── Google Gemini ──────────────────────────────────────────────────────
async function embedWithGemini(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  if (!config.apiKey) {
    throw new Error("Gemini embeddings need an API key — set embeddingApiKey or EMBEDDING_API_KEY.");
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const model = config.model.replace(/^models\//, "");
  // The key travels in a header rather than the query string, so it stays out
  // of proxy and error logs.
  const headers = { "Content-Type": "application/json", "x-goog-api-key": config.apiKey };

  if (texts.length === 1) {
    const url = `${baseUrl}/models/${model}:embedContent`;
    const response = await axios.post(
      url,
      { content: { parts: [{ text: texts[0] }] }, outputDimensionality: config.dimension },
      requestConfig(url, headers)
    );
    return [checkDimension(response.data?.embedding?.values, config)];
  }

  const url = `${baseUrl}/models/${model}:batchEmbedContents`;
  const response = await axios.post(
    url,
    {
      requests: texts.map(text => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: config.dimension,
      })),
    },
    requestConfig(url, headers)
  );

  const embeddings = response.data?.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error("Gemini batchEmbedContents returned no embeddings");
  }
  return embeddings.map((entry: any) => checkDimension(entry?.values, config));
}

function embedBatch(
  texts: string[],
  task: "query" | "document",
  config: EmbeddingConfig
): Promise<number[][]> {
  switch (config.provider) {
    case "openai-compatible":
      return embedWithOpenAI(texts, config);
    case "gemini":
      return embedWithGemini(texts, config);
    default:
      // Ollama takes one prompt per call, so the batch fans out.
      return Promise.all(texts.map(text => embedWithOllama(text, task, config)));
  }
}

async function embedBatchWithRetry(
  texts: string[],
  task: "query" | "document",
  config: EmbeddingConfig
): Promise<number[][]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await reserveQuota(config.provider, texts);
      return await embedBatch(texts, task, config);
    } catch (err: any) {
      // A wrong-width vector is a configuration problem; retrying only stalls.
      if (err instanceof EmbeddingDimensionError) throw err;

      if (err.code === "ECONNREFUSED" && config.provider === "ollama") {
        throw new Error("Ollama is not running. Start it with: ollama serve");
      }

      const limited = rateLimitInfo(err);
      if (limited) {
        const named = limited.quota ? ` (${limited.quota})` : "";

        if (limited.daily) {
          throw new Error(
            `${config.provider} daily quota exhausted${named}. It resets on the provider's own ` +
            "clock, so switch to a local model or a higher tier rather than waiting on a retry."
          );
        }

        if (attempt < MAX_RETRIES) {
          // The provider says how long it wants. Guessing shorter only earns
          // another refusal, and each refusal still spends from the daily cap.
          const waitMs = limited.retryAfterMs || Math.min(60_000, 5000 * 2 ** attempt);
          logger.warn(
            `[ArcRift] ${config.provider} rate limited${named} — waiting ${Math.ceil(waitMs / 1000)}s ` +
            `before retry ${attempt + 1}/${MAX_RETRIES}.`
          );
          await sleep(waitMs);
          continue;
        }

        logger.error("Embedding generation failed:", err?.message);
        throw new Error(
          `${config.provider} embedding failed (${config.model}): still rate limited${named} after ` +
          `${MAX_RETRIES} retries. Lower EMBEDDING_RPM/EMBEDDING_TPM to pace further below the quota.`
        );
      }

      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      if (isTimeout && attempt < MAX_RETRIES) {
        logger.warn(
          config.provider === "ollama"
            ? "[ArcRift] Embedding timeout. Ollama might be busy or model is loading."
            : `[ArcRift] Embedding timeout from ${config.provider}.`
        );
        await sleep(5000 * (attempt + 1));
        continue;
      }

      logger.error("Embedding generation failed:", err?.message);
      if (config.provider === "ollama") {
        throw new Error(`Ollama embedding failed (${config.model}). Is it pulled? Run: ollama pull ${config.model}`);
      }
      throw new Error(`${config.provider} embedding failed (${config.model}): ${err?.message}`);
    }
  }
  throw new Error("Embedding generation failed after retries.");
}

export async function generateEmbedding(text: string, task: "query" | "document" = "query"): Promise<number[]> {
  const config = getEmbeddingConfig();
  const [embedding] = await embedBatchWithRetry([text], task, config);
  if (!embedding) throw new Error(`${config.provider} returned no embedding for the query`);
  return embedding;
}

/**
 * Generate embeddings in batches to prevent overwhelming the provider.
 * Previously, 100 chunks = 100 concurrent HTTP calls (timed out).
 * Batch size and the rest between batches come from the provider.
 */
export async function generateEmbeddings(
  texts: string[],
  task: "query" | "document" = "document",
  onBatch?: (vectors: number[][], startIndex: number) => void
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = getEmbeddingConfig();
  const { size, delayMs } = BATCHING[config.provider] || BATCHING.ollama;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    logger.debug(`[ArcRift] Embedding batch ${Math.floor(i / size) + 1}/${Math.ceil(texts.length / size)}...`);

    let vectors: number[][];
    try {
      vectors = await embedBatchWithRetry(batch, task, config);
    } catch (err: any) {
      logger.error(`[ArcRift] Batch embedding failed at index ${i}: ${err.message}`);
      throw err;
    }

    results.push(...vectors);
    // Handed over before the next batch goes out, so a caller can persist as it
    // goes. On a daily-capped key the requests already paid for should survive
    // a later refusal rather than being re-earned from the start.
    onBatch?.(vectors, i);

    // Tiny rest to let a local CPU breathe. Hosted providers set this to 0.
    if (delayMs > 0 && i + size < texts.length) {
      await sleep(delayMs);
    }
  }

  return results;
}

/** Probes Ollama itself, whichever provider the index is embedded with. */
export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
  /** Dimension the provider advertises, when it says. */
  dimension?: number;
  /** False for models the provider lists but cannot embed with. */
  suitable: boolean;
}

/**
 * Ask a provider what it can run, so the model does not have to be typed from
 * memory. Credentials are taken from the argument rather than the saved
 * settings, so a key can be checked before it is committed to disk.
 */
export async function listProviderModels(override?: {
  provider?: EmbeddingProvider;
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderModel[]> {
  const saved = getEmbeddingConfig();
  const provider = override?.provider || saved.provider;
  const apiKey = override?.apiKey || (override?.provider && override.provider !== saved.provider ? "" : saved.apiKey);
  const baseUrl = override?.baseUrl || (override?.provider && override.provider !== saved.provider ? "" : saved.baseUrl);

  if (provider === "gemini") {
    if (!apiKey) throw new Error("A Gemini API key is required to list models.");

    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    const response = await axios.get(url, requestConfig(url, { "x-goog-api-key": apiKey }));
    const models = Array.isArray(response.data?.models) ? response.data.models : [];

    return models.map((m: any) => {
      const id = String(m.name || "").replace(/^models\//, "");
      const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      return {
        id,
        label: m.displayName || id,
        description: m.description,
        // Gemini reports this only on some models; absent means "ask for what
        // you want" rather than "fixed width".
        dimension: typeof m.outputDimensionality === "number" ? m.outputDimensionality : undefined,
        suitable: methods.includes("embedContent") || methods.includes("batchEmbedContents")
      };
    });
  }

  if (provider === "openai-compatible") {
    const root = (baseUrl || "").replace(/\/+$/, "").replace(/\/embeddings$/, "");
    if (!root) throw new Error("A base URL is required to list models.");

    const url = `${root}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await axios.get(url, requestConfig(url, headers));
    const models = Array.isArray(response.data?.data) ? response.data.data : [];

    return models.map((m: any) => {
      const id = String(m.id || "");
      return {
        id,
        label: id,
        // No capability field in this API, so the name is the only signal.
        suitable: /embed/i.test(id)
      };
    });
  }

  const root = (baseUrl || process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
  const url = `${root}/api/tags`;
  const response = await axios.get(url, requestConfig(url, {}));
  const models = Array.isArray(response.data?.models) ? response.data.models : [];

  return models.map((m: any) => {
    const id = String(m.name || "");
    return {
      id,
      label: id,
      // Ollama does not say which models embed, so the name is the only signal
      // and anything unmatched is still offered, just not promoted.
      suitable: /embed/i.test(id)
    };
  });
}

export async function checkOllamaHealth(): Promise<boolean> {
  const config = getEmbeddingConfig();
  const baseUrl = config.provider === "ollama"
    ? config.baseUrl
    : process.env.OLLAMA_URL || "http://localhost:11434";
  try {
    await axios.get(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
