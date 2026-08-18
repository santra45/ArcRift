/**
 * mcp/tools/memory_relation_list.ts — memory_relation_list tool
 *
 * The typed links into and out of one memory.
 */

import { memoryStore } from "../../services/storage";

export async function memoryRelationList(
  memoryId: string,
  direction?: "out" | "in" | "both",
  relationTypes?: string[],
  status?: string,
  limit?: number
): Promise<string> {
  try {
    if (!memoryId) {
      return "memory_relation_list needs a memory_id.";
    }

    const id = String(memoryId);
    const relations = await memoryStore.listRelations(id, {
      direction,
      relationTypes: Array.isArray(relationTypes) ? relationTypes : undefined,
      status,
      limit
    });

    if (relations.length === 0) {
      return `Memory "${id}" has no relations matching that filter.`;
    }

    const lines = relations.map(r => {
      const outgoing = r.sourceMemoryId === id;
      const arrow = r.bidirectional ? "<->" : (outgoing ? "->" : "<-");
      const other = outgoing ? r.targetMemoryId : r.sourceMemoryId;
      const reason = r.reason ? ` — ${r.reason}` : "";
      return `- ${r.relationType} ${arrow} ${other} (${r.id}, strength ${r.strength})${reason}`;
    });

    return `Relations for memory "${id}" (${relations.length}):\n${lines.join("\n")}`;
  } catch (err: any) {
    return `memory_relation_list failed: ${err.message ?? String(err)}`;
  }
}
