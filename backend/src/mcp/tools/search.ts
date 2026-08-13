/**
 * mcp/tools/search.ts — search_memory tool
 * 
 * Semantic search across ALL sessions and projects.
 */

import { vectorStore, graphStore, sessionStore } from "../../services/storage";
import { extractEntitiesFromQuery } from "../../services/extractor";
import { sanitizeChunks } from "../../middleware/sanitize";

export async function search(
  query: string,
  topN: number = 5
): Promise<string> {
  try {
    const clampedN = Math.max(1, Math.min(topN, 10));
    
    // 1. Graph enrichment (with fallback)
    let relatedTriples: any[] = [];
    try {
      const entities = await extractEntitiesFromQuery(query);
      if (entities.length > 0) {
        relatedTriples = await graphStore.findRelatedTriplesGlobal(entities);
      }
    } catch (err) {
      // Graceful fallback: extraction failed, continue with vector only
    }

    // 2. Vector search
    const chunks = await vectorStore.retrieveGlobalChunks(query, clampedN);

    if (chunks.length === 0 && relatedTriples.length === 0) {
      return `No results found for: "${query}". Try different keywords or list_projects to browse.`;
    }

    const safe = sanitizeChunks(chunks);

    // Results span every project, so each hit is labelled with the project it
    // came from. Falls back to the raw id, and to "unknown" when a result
    // carries no session at all — this used to throw and fail the whole search.
    let projectNames = new Map<string, string>();
    try {
      const sessions = await sessionStore.getSessions();
      projectNames = new Map(sessions.map(s => [String(s._id), s.projectName]));
    } catch {
      // Labels degrade to raw ids; the results themselves are still useful.
    }
    const label = (sessionId?: string) =>
      !sessionId ? "unknown" : projectNames.get(String(sessionId)) || String(sessionId).slice(0, 8);

    let response = `Global search results for "${query}":\n\n`;

    if (relatedTriples.length > 0) {
      response += `STRUCTURED FACTS (from Knowledge Graph):\n`;
      response += relatedTriples
        .map(t => `- [${label(t.sessionId)}] ${t.subject} ${t.relation} ${t.object}`)
        .join("\n");
      response += `\n\n`;
    }

    if (safe.length > 0) {
      response += `RELEVANT CONTEXT CHUNKS:\n`;
      response += safe.map((c, i) =>
        `[${i + 1}] project="${label(c.sessionId)}" | relevance=${(c.score * 100).toFixed(0)}%\n${c.content}`
      ).join("\n\n---\n\n");
    }

    return response;
  } catch (err: any) {
    return `search_memory failed: ${err.message ?? String(err)}`;
  }
}
