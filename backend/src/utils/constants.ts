/**
 * Centralized constants for the ArcRift backend.
 */

/**
 * Minimum score a retrieved chunk needs before it is injected as context.
 *
 * The vector stores already drop anything below 0.30, so a stricter gate here
 * discards results the retrieval layer considered good. The previous value of
 * 0.50 sat above what this embedding setup actually produces: with
 * nomic-embed-text scored as exp(-distance/20), genuinely relevant chunks
 * measured 0.38-0.50, so most sessions could never inject anything at all.
 *
 * Note that an absolute threshold discriminates poorly here — in a session of
 * pasted terminal output, relevant and unrelated queries scored 0.394 and 0.381.
 * Separating those properly needs a better distance-to-score mapping, not a
 * different cutoff. Override with RAG_RELEVANCE_THRESHOLD while tuning.
 */
export const RAG_RELEVANCE_THRESHOLD =
  Number(process.env.RAG_RELEVANCE_THRESHOLD) || 0.30;

export const VALID_PLATFORMS = [
  "claude",
  "chatgpt",
  "gemini",
  "deepseek",
  "grok",
  "copilot",
  "mistral",
  "mcp"
] as const;

export type Platform = typeof VALID_PLATFORMS[number];
