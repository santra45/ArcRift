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
  "gemini": { size: 100, delayMs: 0 },
};

/**
 * A provider returned a vector the index cannot hold.
 *
 * Reshaping it — truncating or zero-padding — would leave the table holding
 * vectors of different provenance whose L2 distances no longer compare, so this
 * is raised instead, and it is never retried.
 */
export class EmbeddingDimensionError extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
      if (attempt > 0) {
        await sleep(5000 * attempt);
        logger.debug(`[ArcRift] Retrying embedding generation (attempt ${attempt}/${MAX_RETRIES})...`);
      }

      return await embedBatch(texts, task, config);
    } catch (err: any) {
      // A wrong-width vector is a configuration problem; retrying only stalls.
      if (err instanceof EmbeddingDimensionError) throw err;

      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");

      if (err.code === "ECONNREFUSED" && config.provider === "ollama") {
        throw new Error("Ollama is not running. Start it with: ollama serve");
      }

      if (isTimeout && attempt < MAX_RETRIES) {
        logger.warn(
          config.provider === "ollama"
            ? "[ArcRift] Embedding timeout. Ollama might be busy or model is loading."
            : `[ArcRift] Embedding timeout from ${config.provider}.`
        );
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
export async function generateEmbeddings(texts: string[], task: "query" | "document" = "document"): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = getEmbeddingConfig();
  const { size, delayMs } = BATCHING[config.provider] || BATCHING.ollama;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    logger.debug(`[ArcRift] Embedding batch ${Math.floor(i / size) + 1}/${Math.ceil(texts.length / size)}...`);

    try {
      results.push(...await embedBatchWithRetry(batch, task, config));
    } catch (err: any) {
      logger.error(`[ArcRift] Batch embedding failed at index ${i}: ${err.message}`);
      throw err;
    }

    // Tiny rest to let a local CPU breathe. Hosted providers set this to 0.
    if (delayMs > 0 && i + size < texts.length) {
      await sleep(delayMs);
    }
  }

  return results;
}

/** Probes Ollama itself, whichever provider the index is embedded with. */
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
