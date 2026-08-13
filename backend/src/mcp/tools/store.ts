/**
 * mcp/tools/store.ts — store_memory tool
 * 
 * Manually save a new fact or context block into a project.
 */

import { sessionStore, vectorStore } from "../../services/storage";
import { enqueueJob } from "../../services/jobs";
import { slidingWindowChunks } from "../../services/chunker";
import { logger } from "../../utils/logger";
import { mergeChatText, splitTurns } from "../../utils/chat-merge";

export async function store(
  content: string,
  project: string
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

    // 4. Update Stats — tripleCount is maintained by the extraction job.
    await sessionStore.updateSession(sessionId, { updatedAt: new Date() });

    return `Successfully stored memory in project "${session.projectName}" (${sessionId}).\n- Visible in Dashboard: Yes\n- Searchable now: Yes (${chunks.length} chunks indexed)\n- Fact extraction: running in the background`;
  } catch (err: any) {
    return `store_memory failed: ${err.message ?? String(err)}`;
  }
}
