/**
 * mcp/tools/memory_supersede.ts — memory_supersede tool
 *
 * Records that one memory replaced another. The older claim stops being
 * returned by ordinary reads but stays readable as history.
 */

import { memoryStore } from "../../services/storage";

export async function memorySupersede(
  oldMemoryId: string,
  newMemoryId: string,
  reason?: string
): Promise<string> {
  try {
    if (!oldMemoryId || !newMemoryId) {
      return "memory_supersede needs both old_memory_id and new_memory_id.";
    }

    const result = await memoryStore.supersedeMemory(
      String(oldMemoryId),
      String(newMemoryId),
      reason
    );

    return `Memory "${result.newMemory.id}" now supersedes "${result.oldMemory.id}".\n` +
           `- Superseded: ${result.oldMemory.id} (no longer returned by default)\n` +
           `- Current: ${result.newMemory.id}\n` +
           `- Reason: ${reason || "Not given"}`;
  } catch (err: any) {
    return `memory_supersede failed: ${err.message ?? String(err)}`;
  }
}
