// rag.ts (backend route) — v1.5.1

import { Router, Request, Response } from "express";
import { vectorStore, graphStore, sessionStore, RetrievedChunk } from "../services/storage";
import { extractEntitiesFromQuery, summarizeContext } from "../services/extractor";
import { IndexFingerprintMismatchError } from "../services/index-fingerprint";
import { reindexEmbeddings } from "../services/reindex";
import { logger } from "../utils/logger";
import { wrapInContextBlock, sanitizeChunks } from "../middleware/sanitize";
import { isValidObjectId } from "../utils/validators";
import { getSettings } from "../utils/settings";
import { RAG_RELEVANCE_THRESHOLD } from "../utils/constants";

/** Caller-supplied topN, clamped. Falls back to the route's own default. */
function resolveChunkLimit(topN: unknown, fallback: number): number {
  const requested = Math.floor(Number(topN));
  if (!Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(requested, 25);
}

/**
 * Assemble the context block inside a character budget.
 *
 * Graph facts and the wrapper are part of what gets injected, so they are
 * measured too. Budgeting the chunk text alone let the delivered block run over
 * — 6544 characters against a 6000 budget, in a case with 12 facts attached.
 *
 * Chunks are dropped from the end until the whole assembled block fits, rather
 * than stopping at the first chunk that does not fit, so a single large result
 * no longer ends the fill with budget to spare.
 */
function buildBudgetedContext(
  chunks: RetrievedChunk[],
  facts: any[],
  maxChars: number
): { block: string; used: RetrievedChunk[] } {
  let factsText = facts.map(t => `- ${t.subject} ${t.relation} ${t.object}`).join("\n");

  // Facts must never crowd out retrieved text entirely.
  const factsCap = Math.floor(maxChars / 2);
  if (factsText.length > factsCap) factsText = factsText.slice(0, factsCap) + "\n...";

  const assemble = (list: RetrievedChunk[]) => {
    const wrapped = wrapInContextBlock(list);
    return factsText
      ? `RELATED KNOWLEDGE:\n${factsText}\n\nRETRIEVED CONTEXT:\n${wrapped}`
      : wrapped;
  };

  const used = [...chunks];
  while (used.length > 1 && assemble(used).length > maxChars) used.pop();

  // A lone chunk that still overflows is trimmed rather than dropped, so a long
  // first result does not leave the caller with nothing.
  if (used.length === 1) {
    const over = assemble(used).length - maxChars;
    if (over > 0) {
      const suffix = "\n... (truncated for budget)";
      const keep = Math.max(0, used[0].content.length - over - suffix.length);
      used[0] = { ...used[0], content: used[0].content.slice(0, keep) + suffix };
    }
  }

  return { block: assemble(used), used };
}

const router = Router();

/**
 * A stale index is the caller's to fix, not a server fault — the message names
 * the change and the rebuild, so it is worth passing through instead of
 * flattening into the generic 500.
 */
function sendRetrievalError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof IndexFingerprintMismatchError) {
    res.status(409).json({ error: err.message, reindexRequired: true });
    return;
  }
  res.status(500).json({ error: fallback });
}

// POST /api/rag/retrieve
router.post("/retrieve", async (req: Request, res: Response) => {
  let { prompt, sessionId, topN } = req.body;

  if (!prompt || !sessionId) {
    res.status(400).json({ error: "prompt and sessionId are required" });
    return;
  }

  // v1.4.6: Use unified validator for Mongo/SQLite IDs
  if (!isValidObjectId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId format" });
    return;
  }

  // v1.4.6: Character-based context budgeting
  // We retrieve a larger pool and fill until the budget is reached.
  const MAX_TOTAL_CHARS = 6000;
  // 10 preserves the pool this route used before topN was honoured.
  const maxChunks = resolveChunkLimit(topN, 10);

  try {
    logger.info(`RAG retrieve (budget=${MAX_TOTAL_CHARS} chars): "${String(prompt).slice(0, 60)}..." for session ${sessionId}`);

    // ── Hybrid Search (Graph Enrichment) ───────────────────
    const entities = await extractEntitiesFromQuery(prompt);
    let relatedTriples: any[] = [];
    if (entities.length > 0) {
      relatedTriples = await graphStore.findRelatedTriples(entities, sessionId);
    }

    // Retrieve a larger candidate pool for budgeting with Keyword Boosting
    const rawCandidateChunks = await vectorStore.retrieveRelevantChunks(prompt, sessionId, maxChunks, entities);

    // v1.6.3: Filter out low-relevance chunks to prevent hallucination
    const candidateChunks = rawCandidateChunks.filter(c => (c.score || 0) >= RAG_RELEVANCE_THRESHOLD);

    if (candidateChunks.length === 0 && relatedTriples.length === 0) {
      res.json({ found: false, chunks: [], graphFacts: [] });
      return;
    }

    // Sanitise (redact injection patterns) before budgeting, so the measurement
    // matches what actually gets delivered.
    const sanitizedCandidates = sanitizeChunks(candidateChunks);
    const { block, used } = buildBudgetedContext(sanitizedCandidates, relatedTriples, MAX_TOTAL_CHARS);
    const sanitized = used;

    // v1.4.4 style: inject raw chunks directly (no LLM extraction step)
    let contextBlockRaw = block;

    if (getSettings().contextMode === "summarized") {
      const chunksContent = sanitized.map(c => c.content);
      const factsContent = relatedTriples.map(t => `- ${t.subject} ${t.relation} ${t.object}`);
      const summary = await summarizeContext(String(prompt), chunksContent, factsContent);
      contextBlockRaw = `SUMMARIZED CONTEXT:\n${summary}`;
    }

    const contextBlock = contextBlockRaw.trim();
    if (!contextBlock) {
      res.json({ found: false, chunks: [], graphFacts: [] });
      return;
    }

    // Analytics: Tokens saved calculation
    try {
      const session = await sessionStore.getSession(sessionId);
      const fullChat = await sessionStore.getFullChat(sessionId);
      
      if (session && fullChat) {
        // Approximate 1 token = 4 characters
        const fullTokens = Math.floor(fullChat.rawText.length / 4);
        const injectedTokens = Math.floor(contextBlock.length / 4);
        const tokensSavedThisTurn = Math.max(0, fullTokens - injectedTokens);

        const newTokensSaved = (session.tokensSaved || 0) + tokensSavedThisTurn;
        const newRetrievalCount = (session.retrievalCount || 0) + 1;
        
        await sessionStore.updateSession(sessionId, { 
          tokensSaved: newTokensSaved, 
          retrievalCount: newRetrievalCount 
        });
        
        logger.debug(`Analytics updated for ${sessionId}: +${tokensSavedThisTurn} tokens saved.`);
      }
    } catch (analyticsErr) {
      logger.warn(`Failed to update session analytics: ${analyticsErr}`);
    }

    logger.success(`RAG: Budget filled (${contextBlock.length}/${MAX_TOTAL_CHARS} chars). ${sanitized.length} chunks used.`);

    res.json({
      found: true,
      chunks: sanitized,
      graphFacts: relatedTriples,
      contextBlock,
      chunksFound: sanitized.map(c => c.chunkIndex),
      scores: sanitized.map(c => c.score),
    });
  } catch (err) {
    logger.error("RAG error:", err);
    sendRetrievalError(res, err, "Failed to retrieve context");
  }
});

// POST /api/rag/global — search across ALL sessions
router.post("/global", async (req: Request, res: Response) => {
  let { prompt, topN } = req.body;

  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  // v1.4.6: Character-based context budgeting
  const MAX_TOTAL_CHARS = 4000; // Lower for global to avoid noisy context
  // 8 preserves the pool this route used before topN was honoured.
  const maxChunks = resolveChunkLimit(topN, 8);

  try {
    logger.info(`RAG Global (budget=${MAX_TOTAL_CHARS}): "${String(prompt).slice(0, 60)}..."`);

    // Extract entities for Global search boosting
    const entities = await extractEntitiesFromQuery(prompt);

    let relatedTriples: any[] = [];
    if (entities.length > 0) {
      relatedTriples = await graphStore.findRelatedTriplesGlobal(entities);
    }

    // Retrieve a larger candidate pool with Keyword Boosting
    const rawCandidateChunks = await vectorStore.retrieveGlobalChunks(prompt, maxChunks, entities);

    // v1.6.3: Filter out low-relevance chunks to prevent hallucination
    const candidateChunks = rawCandidateChunks.filter(c => (c.score || 0) >= RAG_RELEVANCE_THRESHOLD);

    if (candidateChunks.length === 0 && relatedTriples.length === 0) {
      res.json({ found: false, chunks: [], graphFacts: [] });
      return;
    }

    const sanitizedCandidates = sanitizeChunks(candidateChunks);
    const { block, used } = buildBudgetedContext(sanitizedCandidates, relatedTriples, MAX_TOTAL_CHARS);
    const sanitized = used;

    let contextBlockRaw = block;

    if (getSettings().contextMode === "summarized") {
      const chunksContent = sanitized.map(c => c.content);
      const factsContent = relatedTriples.map(t => `- ${t.subject} ${t.relation} ${t.object}`);
      const summary = await summarizeContext(String(prompt), chunksContent, factsContent);
      contextBlockRaw = `SUMMARIZED CONTEXT:\n${summary}`;
    }

    const contextBlock = contextBlockRaw.trim();

    if (!contextBlock) {
      res.json({ found: false, chunks: [], graphFacts: [] });
      return;
    }

    logger.success(`RAG Global: Budget filled (${contextBlock.length}/${MAX_TOTAL_CHARS} chars). ${sanitized.length} chunks used. ${relatedTriples.length} facts found.`);

    res.json({
      found: true,
      chunks: sanitized,
      graphFacts: relatedTriples,
      contextBlock,
      scores: sanitized.map(c => c.score),
    });
  } catch (err) {
    logger.error("Global RAG error:", err);
    sendRetrievalError(res, err, "Failed to retrieve global context");
  }
});

// POST /api/rag/reindex — re-embed every stored chunk and sentence with the
// embedding backend currently configured, then stamp the index with it.
router.post("/reindex", async (_req: Request, res: Response) => {
  try {
    const result = await reindexEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("Re-index error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to rebuild the embedding index"
    });
  }
});

export default router;
