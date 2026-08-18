import path from "path";
import fs from "fs";
import { logger } from "./logger";

export type EmbeddingProvider = "ollama" | "openai-compatible" | "gemini";
export type ExtractionProvider = "ollama" | "groq" | "local-openai";

export interface Settings {
  ollamaEmbeddingModel?: string;
  ollamaExtractionModel?: string;
  contextMode?: "raw" | "summarized";

  // Embedding backend. Absent means Ollama, so an install that never touches
  // these keeps talking to the local daemon exactly as it did before.
  embeddingProvider?: EmbeddingProvider;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDimension?: number;

  // Extraction backend. Absent means the probe order in extractor.ts decides,
  // which is what installs relied on before this was configurable.
  extractionProvider?: ExtractionProvider;
  extractionBaseUrl?: string;
  extractionApiKey?: string;
  extractionModel?: string;
}

/** The embedding backend a call should use, with every fallback already applied. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
}

/** The extraction backend, or provider `null` to leave the choice to probing. */
export interface ExtractionConfig {
  provider: ExtractionProvider | null;
  baseUrl: string;
  apiKey: string;
  model: string;
}

// vec_chunks and vec_sentences are declared float[768] and a vec0 table's
// dimension is fixed at creation, so this is the only width the index holds.
export const DEFAULT_EMBEDDING_DIMENSION = 768;

const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { baseUrl: string; model: string }> = {
  "ollama": { baseUrl: "http://localhost:11434", model: "nomic-embed-text" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  "gemini": { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "text-embedding-004" },
};

export const EXTRACTION_DEFAULTS: Record<ExtractionProvider, { baseUrl: string; model: string }> = {
  "ollama": { baseUrl: "http://localhost:11434", model: "llama3.1:8b" },
  "groq": { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  "local-openai": { baseUrl: "http://localhost:1234/v1", model: "local-model" },
};

/**
 * A base URL only means anything next to the provider it was saved for. Left
 * unchecked, switching provider kept the previous endpoint — Gemini requests
 * went to the local Ollama port and came back as a bare 404.
 */
export function baseUrlSuitsProvider(provider: EmbeddingProvider, baseUrl: string): boolean {
  if (!baseUrl) return false;
  return !Object.entries(PROVIDER_DEFAULTS).some(
    ([other, defaults]) => other !== provider && defaults.baseUrl === baseUrl
  );
}

export function defaultsForProvider(provider: EmbeddingProvider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.ollama;
}

export function extractionBaseUrlSuits(provider: ExtractionProvider, baseUrl: string): boolean {
  if (!baseUrl) return false;
  return !Object.entries(EXTRACTION_DEFAULTS).some(
    ([other, defaults]) => other !== provider && defaults.baseUrl === baseUrl
  );
}

export function extractionDefaultsFor(provider: ExtractionProvider) {
  return EXTRACTION_DEFAULTS[provider] || EXTRACTION_DEFAULTS.ollama;
}

// Overridable so a test run cannot pick up whatever provider the developer
// happens to have configured — the integration suite embedded through a real
// cloud provider once this file gained an API key.
const SETTINGS_PATH =
  process.env.ARCRIFT_SETTINGS_PATH || path.join(process.cwd(), "ArcRift-settings.json");

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
      cachedSettings = JSON.parse(data);
      logger.info(`[ArcRift] Settings loaded from ${SETTINGS_PATH}`);
    } else {
      cachedSettings = {};
    }
  } catch (err: any) {
    logger.error(`[ArcRift] Failed to read settings file: ${err.message}`);
    cachedSettings = {};
  }
  return cachedSettings!;
}

export function updateSettings(settings: Partial<Settings>): Settings {
  const current = getSettings();
  const updated = { ...current, ...settings };
  cachedSettings = updated;
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
    logger.success(`[ArcRift] Settings updated at ${SETTINGS_PATH}`);
  } catch (err: any) {
    logger.error(`[ArcRift] Failed to write settings file: ${err.message}`);
  }
  return updated;
}

/**
 * Resolve the active embedding backend.
 *
 * The provider decides which defaults apply; ollamaEmbeddingModel and
 * OLLAMA_EMBED_MODEL are still honoured for the Ollama provider so installs
 * that only ever set those keep the model their index was built with.
 */
/**
 * Extraction backend. A saved provider wins over GRAPH_BACKEND: it is what the
 * dashboard shows, and silently overriding it from the environment makes the
 * screen lie about which model is running.
 *
 * `provider: null` means nothing was chosen and extractor.ts should probe, the
 * behaviour every install had before this became configurable.
 */
export function getExtractionConfig(): ExtractionConfig {
  const settings = getSettings();
  const envBackend = process.env.GRAPH_BACKEND?.toLowerCase();
  const provider: ExtractionProvider | null =
    settings.extractionProvider ||
    (envBackend === "groq" || envBackend === "ollama" || envBackend === "local-openai" ? envBackend : null);

  const defaults = provider ? EXTRACTION_DEFAULTS[provider] : EXTRACTION_DEFAULTS.ollama;
  const savedBaseUrl =
    provider && extractionBaseUrlSuits(provider, settings.extractionBaseUrl || "")
      ? settings.extractionBaseUrl
      : "";

  const envBaseUrl =
    provider === "ollama" ? process.env.OLLAMA_URL
      : provider === "local-openai" ? process.env.LOCAL_OPENAI_URL
      : "";

  return {
    provider,
    baseUrl: savedBaseUrl || envBaseUrl || defaults.baseUrl,
    apiKey: settings.extractionApiKey || process.env.GROQ_API_KEY || "",
    model:
      settings.extractionModel ||
      (provider === "ollama"
        ? settings.ollamaExtractionModel || process.env.OLLAMA_MODEL
        : provider === "groq"
          ? process.env.GROQ_MODEL
          : "") ||
      defaults.model,
  };
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const settings = getSettings();
  const provider = settings.embeddingProvider || "ollama";
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.ollama;
  const isOllama = provider === "ollama";

  // Ignore an endpoint that plainly belongs to a different provider rather than
  // sending this one's requests to it.
  const savedBaseUrl = baseUrlSuitsProvider(provider, settings.embeddingBaseUrl || "")
    ? settings.embeddingBaseUrl
    : "";

  return {
    provider,
    baseUrl: savedBaseUrl || (isOllama ? process.env.OLLAMA_URL : "") || defaults.baseUrl,
    apiKey: settings.embeddingApiKey || process.env.EMBEDDING_API_KEY || "",
    model:
      settings.embeddingModel ||
      (isOllama ? settings.ollamaEmbeddingModel || process.env.OLLAMA_EMBED_MODEL : "") ||
      defaults.model,
    dimension: settings.embeddingDimension || DEFAULT_EMBEDDING_DIMENSION,
  };
}
