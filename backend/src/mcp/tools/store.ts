/**
 * mcp/tools/store.ts — store_memory tool
 * 
 * Manually save a new fact or context block into a project.
 */

import { memoryStore, sessionStore, vectorStore } from "../../services/storage";
import { MemoryCategory } from "../../services/storage.types";
import { enqueueJob } from "../../services/jobs";
import { slidingWindowChunks } from "../../services/chunker";
import { logger } from "../../utils/logger";
import { mergeChatText, splitTurns } from "../../utils/chat-merge";
import { DEFAULT_IMPORTANCE, ImportanceLevel, importanceLabel, importanceToScore } from "../../utils/importance";

/** Long enough to tell two cards apart in a list, short enough to be a title. */
const TITLE_MAX_LENGTH = 60;

/**
 * A card needs a title even when the caller did not think of one. The first
 * line is what a note is usually headed with, minus the markdown that heads it.
 */
function deriveTitle(content: string): string {
  const firstLine = content.split("\n")[0].replace(/^[#\s\-*]+/, "").trim();
  return firstLine.slice(0, TITLE_MAX_LENGTH) || "Memory Item";
}

export async function store(
  content: string,
  project: string,
  importance: ImportanceLevel | number = DEFAULT_IMPORTANCE,
  category: MemoryCategory = "Note",
  title?: string,
  tags?: string[]
): Promise<string> {
  try {
    const projectStr = String(project);
    let session = await sessionStore.getSession(projectStr);

    // Auto-create project if it doesn't exist
    if (!session) {
      // Try searching by name first to avoid duplicates
      session = await sessionStore.getSessionByName(projectStr);
      
      if (!session) {
        logger.info(`[ArcRift MCP] Auto-creating project: "${projectStr}"`);
        // Let the store generate the ID. Passing the project name as a customId
        // produces a session ID that isValidObjectId() rejects, which 400s every
        // REST route (dashboard, extension) that touches the project.
        session = await sessionStore.createSession(projectStr, "mcp");
      }
    }

    const sessionId = session._id;
    logger.info(`[ArcRift MCP] Using Session ID: "${sessionId}" for project: "${projectStr}"`);

    // 1. Save Full Chat (for Dashboard visualization)
    // Merge into what is already stored — saving the raw content would replace
    // every memory previously stored against this project.
    const existingChat = await sessionStore.getFullChat(sessionId);
    const { merged, added } = mergeChatText(existingChat?.rawText || "", content);

    if (!added) {
      return `That memory is already stored in project "${session.projectName}" (${sessionId}). Nothing to add.`;
    }

    await sessionStore.saveFullChat(sessionId, merged, splitTurns(merged).length, "mcp");

    // 2. Vector Storage (Batched)
    // Chunk the merged transcript: storeChunks replaces the session's chunks,
    // so chunking only the new content would drop the earlier memories.
    const chunks = slidingWindowChunks(merged, sessionId, 150, 50);
    await vectorStore.storeChunks(chunks);

    // 3. Fact extraction runs in the background.
    // Inline, it cost two LLM calls plus five seconds of rate-limit sleeps for
    // every 2000 characters, so storing anything long outlived the client's
    // timeout. The worker started by the MCP server picks this up immediately
    // and brings checkpointing and retries with it.
    await enqueueJob("triple_extraction", {
      sessionId,
      text: added,
      processVectors: false // already stored above
    });

    // 4. Structured memory card — the content as one titled, filed entry.
    // Best effort: memories are a SQLite-only feature, so in Docker mode this
    // rejects by design, and the transcript above is what store_memory is for.
    const cardTitle = title?.trim() || deriveTitle(content);
    let cardCreated = false;

    try {
      await memoryStore.createMemory({
        sessionId,
        title: cardTitle,
        content,
        importance: importanceToScore(importance),
        category,
        tags: Array.isArray(tags) ? tags : [],
        source: "mcp"
      });
      cardCreated = true;
    } catch (err: any) {
      logger.warn(`[ArcRift MCP] No memory card recorded for session "${sessionId}": ${err.message ?? String(err)}`);
    }

    // 5. Update Stats — tripleCount is maintained by the extraction job.
    await sessionStore.updateSession(sessionId, { updatedAt: new Date() });

    const cardLine = cardCreated
      ? `\n- Memory Card Created: "${cardTitle}" [${importanceLabel(importance)}, ${category}]`
      : "";

    return `Successfully stored memory in project "${session.projectName}" (${sessionId}).${cardLine}\n- Visible in Dashboard: Yes\n- Searchable now: Yes (${chunks.length} chunks indexed)\n- Fact extraction: running in the background`;
  } catch (err: any) {
    return `store_memory failed: ${err.message ?? String(err)}`;
  }
}
