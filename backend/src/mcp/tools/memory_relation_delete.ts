/**
 * mcp/tools/memory_relation_delete.ts — memory_relation_delete tool
 *
 * Removes a single typed link. The memories it joined are left alone.
 */

import { memoryStore } from "../../services/storage";

export async function memoryRelationDelete(relationId: string): Promise<string> {
  try {
    if (!relationId) {
      return "memory_relation_delete needs a relation_id.";
    }

    const id = String(relationId);
    const deleted = await memoryStore.deleteRelation(id);

    return deleted
      ? `Deleted relation "${id}".`
      : `Relation "${id}" not found. Use memory_relation_list to see valid IDs.`;
  } catch (err: any) {
    return `memory_relation_delete failed: ${err.message ?? String(err)}`;
  }
}
