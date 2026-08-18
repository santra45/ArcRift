/**
 * mcp/tools/memory_evolves_chain.ts — memory_evolves_chain tool
 *
 * Every revision of a claim in order, so a superseded memory can still be read
 * alongside what replaced it.
 */

import { memoryStore } from "../../services/storage";

export async function memoryEvolvesChain(memoryId: string, maxDepth?: number): Promise<string> {
  try {
    if (!memoryId) {
      return "memory_evolves_chain needs a memory_id.";
    }

    const id = String(memoryId);
    const { chain, position, totalVersions } = await memoryStore.getEvolutionChain(id, maxDepth);

    if (totalVersions <= 1) {
      return `Memory "${id}" has no earlier or later revisions.`;
    }

    const revisions = chain.map((revision, i) => {
      const state = revision.isLatest ? "current" : "superseded";
      const relation = revision.evolvesRelation ? `, ${revision.evolvesRelation}` : "";
      const marker = i === position ? " <- the memory asked about" : "";
      return `[${i + 1}] ${revision.title} (${revision.id})${marker}\n` +
             `    ${state}${relation}, created ${revision.createdAt}`;
    });

    return `Evolution chain for "${id}" — ${totalVersions} revisions, oldest first:\n\n` +
           revisions.join("\n");
  } catch (err: any) {
    return `memory_evolves_chain failed: ${err.message ?? String(err)}`;
  }
}
