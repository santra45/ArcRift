import { Router, Request, Response } from "express";
import axios from "axios";
import {
  EmbeddingProvider,
  getEmbeddingConfig,
  getSettings,
  updateSettings
} from "../utils/settings";
import { generateEmbedding } from "../services/embeddings";
import { readIndexFingerprint } from "../services/index-fingerprint";
import { logger } from "../utils/logger";

const router = Router();
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const EMBEDDING_PROVIDERS: EmbeddingProvider[] = ["ollama", "openai-compatible", "gemini"];

const isProvider = (value: unknown): value is EmbeddingProvider =>
  typeof value === "string" && EMBEDDING_PROVIDERS.includes(value as EmbeddingProvider);

/** Never send a stored key back to the browser — only whether one is set. */
function redactKey(apiKey: string): string {
  if (!apiKey) return "";
  return `••••${apiKey.slice(-4)}`;
}

// GET /api/settings
router.get("/", async (_req: Request, res: Response) => {
  try {
    const settings = getSettings();
    let ollamaReachable = false;
    let availableModels: string[] = [];

    try {
      const response = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 2000 });
      ollamaReachable = true;
      if (response.data && Array.isArray(response.data.models)) {
        availableModels = response.data.models.map((m: any) => m.name);
      }
    } catch {
      ollamaReachable = false;
    }

    const activeEmbeddingModel = settings.ollamaEmbeddingModel || process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
    const activeExtractionModel = settings.ollamaExtractionModel || process.env.OLLAMA_MODEL || "llama3.1:8b";

    const embedding = getEmbeddingConfig();
    const fingerprint = readIndexFingerprint();

    res.json({
      ollamaReachable,
      availableModels,
      activeEmbeddingModel,
      activeExtractionModel,
      // Sent by the dashboard since it was added, but never round-tripped, so
      // the control always reset to "raw" on reload.
      contextMode: settings.contextMode || "raw",
      embedding: {
        providers: EMBEDDING_PROVIDERS,
        provider: embedding.provider,
        baseUrl: embedding.baseUrl,
        model: embedding.model,
        dimension: embedding.dimension,
        apiKeySet: Boolean(embedding.apiKey),
        apiKeyHint: redactKey(embedding.apiKey)
      },
      // The index is only searchable while it agrees with these settings, so
      // the UI needs to know when a change has left a rebuild outstanding.
      index: fingerprint
        ? {
            provider: fingerprint.provider,
            model: fingerprint.model,
            dimension: fingerprint.dimension,
            stale:
              fingerprint.provider !== embedding.provider ||
              fingerprint.model !== embedding.model ||
              fingerprint.dimension !== embedding.dimension
          }
        : null
    });
  } catch (err: any) {
    logger.error("Failed to fetch settings:", err?.message);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// POST /api/settings
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      activeEmbeddingModel,
      activeExtractionModel,
      contextMode,
      embeddingProvider,
      embeddingBaseUrl,
      embeddingApiKey,
      embeddingModel,
      embeddingDimension
    } = req.body;

    if (embeddingProvider !== undefined && !isProvider(embeddingProvider)) {
      res.status(400).json({ error: `embeddingProvider must be one of: ${EMBEDDING_PROVIDERS.join(", ")}` });
      return;
    }

    const patch: Parameters<typeof updateSettings>[0] = {
      ollamaEmbeddingModel: activeEmbeddingModel,
      ollamaExtractionModel: activeExtractionModel
    };

    if (contextMode === "raw" || contextMode === "summarized") patch.contextMode = contextMode;

    if (embeddingProvider !== undefined) patch.embeddingProvider = embeddingProvider;
    if (typeof embeddingBaseUrl === "string") patch.embeddingBaseUrl = embeddingBaseUrl;
    if (typeof embeddingModel === "string") patch.embeddingModel = embeddingModel;
    if (embeddingDimension !== undefined) patch.embeddingDimension = Number(embeddingDimension);
    // An empty string clears the key; omitting the field leaves it alone, so
    // the UI can save without ever round-tripping the secret it never received.
    if (typeof embeddingApiKey === "string") patch.embeddingApiKey = embeddingApiKey;

    updateSettings(patch);

    const embedding = getEmbeddingConfig();
    const fingerprint = readIndexFingerprint();

    res.json({
      success: true,
      embedding: {
        provider: embedding.provider,
        baseUrl: embedding.baseUrl,
        model: embedding.model,
        dimension: embedding.dimension,
        apiKeySet: Boolean(embedding.apiKey),
        apiKeyHint: redactKey(embedding.apiKey)
      },
      reindexRequired: Boolean(
        fingerprint &&
          (fingerprint.provider !== embedding.provider ||
            fingerprint.model !== embedding.model ||
            fingerprint.dimension !== embedding.dimension)
      )
    });
  } catch (err: any) {
    logger.error("Failed to update settings:", err?.message);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// POST /api/settings/embedding/test — embed a probe string with the saved config.
// Tests what is stored rather than what is in the form, so a passing result
// means the pipeline itself works, not just that the form was filled in.
router.post("/embedding/test", async (_req: Request, res: Response) => {
  const config = getEmbeddingConfig();
  const startedAt = Date.now();

  try {
    const vector = await generateEmbedding("ArcRift embedding connectivity probe", "query");

    res.json({
      success: true,
      provider: config.provider,
      model: config.model,
      dimension: vector.length,
      expectedDimension: config.dimension,
      latencyMs: Date.now() - startedAt
    });
  } catch (err: any) {
    logger.warn(`Embedding provider test failed (${config.provider}): ${err?.message}`);
    res.status(502).json({
      success: false,
      provider: config.provider,
      model: config.model,
      error: err?.message || String(err)
    });
  }
});

export default router;
