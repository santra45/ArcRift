/**
 * mcp/tools/memory_relation_add.ts — memory_relation_add tool
 *
 * Links two memories with a named relation, so a fact can point at the
 * decision it came from rather than each standing alone.
 */

import { memoryStore } from "../../services/storage";

export async function memoryRelationAdd(
  sourceMemoryId: string,
  targetMemoryId: string,
  relationType: string,
  reason?: string,
  strength?: number,
  confidence?: number,
  bidirectional?: boolean,
  status?: "active" | "suggested"
): Promise<string> {
  try {
    if (!sourceMemoryId || !targetMemoryId || !relationType) {
      return "memory_relation_add needs source_memory_id, target_memory_id and relation_type.";
    }

    const relation = await memoryStore.addRelation({
      sourceMemoryId: String(sourceMemoryId),
      targetMemoryId: String(targetMemoryId),
      relationType: String(relationType),
      reason,
      strength,
      confidence,
      bidirectional,
      status
    });

    const arrow = relation.bidirectional ? "<->" : "->";

    return `Linked ${relation.sourceMemoryId} ${arrow} ${relation.targetMemoryId} as "${relation.relationType}".\n` +
           `- Relation ID: ${relation.id}\n` +
           `- Strength: ${relation.strength}, confidence: ${relation.confidence}\n` +
           `- Status: ${relation.status}\n` +
           `- Reason: ${relation.reason || "Not given"}`;
  } catch (err: any) {
    return `memory_relation_add failed: ${err.message ?? String(err)}`;
  }
}
