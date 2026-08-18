import path from "path";
import fs from "fs";
import { logger } from "./logger";

export type EmbeddingProvider = "ollama" | "openai-compatible" | "gemini";

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
}

/** The embedding backend a call should use, with every fallback already applied. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
}

// vec_chunks and vec_sentences are declared float[768] and a vec0 table's
// dimension is fixed at creation, so this is the only width the index holds.
export const DEFAULT_EMBEDDING_DIMENSION = 768;

const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { baseUrl: string; model: string }> = {
  "ollama": { baseUrl: "http://localhost:11434", model: "nomic-embed-text" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  "gemini": { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "text-embedding-004" },
};

const SETTINGS_PATH = path.join(process.cwd(), "ArcRift-settings.json");

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
export function getEmbeddingConfig(): EmbeddingConfig {
  const settings = getSettings();
  const provider = settings.embeddingProvider || "ollama";
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.ollama;
  const isOllama = provider === "ollama";

  return {
    provider,
    baseUrl: settings.embeddingBaseUrl || (isOllama ? process.env.OLLAMA_URL : "") || defaults.baseUrl,
    apiKey: settings.embeddingApiKey || process.env.EMBEDDING_API_KEY || "",
    model:
      settings.embeddingModel ||
      (isOllama ? settings.ollamaEmbeddingModel || process.env.OLLAMA_EMBED_MODEL : "") ||
      defaults.model,
    dimension: settings.embeddingDimension || DEFAULT_EMBEDDING_DIMENSION,
  };
}
