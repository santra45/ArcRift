import { v4 as uuidv4 } from "uuid";
import { getSqlite } from "./sqlite";
import {
  IMemoryStore, Memory, MemoryCategory, MemoryRelation, MemoryRevision, WorkingMemory
} from "./storage.types";
import { levelScore } from "../utils/importance";

/**
 * Importance is a REAL column, but callers still hand us the old level names
 * (REST query strings, MCP arguments, imported records). Anything we cannot
 * read falls back to the column default rather than writing NULL.
 */
function normalizeImportance(value: unknown): number {
  if (typeof value === "number") return clampImportance(value);

  if (typeof value === "string") {
    // Deliberately the same scale the MCP boundary writes with. Two mappings
    // meant a memory saved as "high" (0.75) missed an `importance >= high`
    // filter that resolved "high" to 0.8, and nothing saved as "critical"
    // (0.95) ever cleared a "critical" filter at 1.0.
    const level = levelScore(value);
    if (level !== null) return clampImportance(level);

    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0.5 : clampImportance(parsed);
  }

  return 0.5;
}

function clampImportance(value: number): number {
  return Math.max(0.1, Math.min(1, value));
}

/**
 * LIKE reads `%` and `_` as wildcards, so a filter built by interpolating the
 * caller's text matched far more rows than they asked for — a search for
 * "user_id" also returned "userXid", and a lone "%" returned everything.
 * Escaped patterns only work alongside the ESCAPE clause below.
 */
const LIKE_ESCAPE = "\\";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `${LIKE_ESCAPE}${ch}`);
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function deriveTitle(content: string): string {
  return content.length > 50 ? `${content.slice(0, 50)}...` : content;
}

export class SqliteMemoryStore implements IMemoryStore {
  private db = getSqlite();

  private mapMemory(row: any): Memory {
    // labels and tags are two names for the same list, written in step below.
    const labels = Array.from(new Set([...parseJsonArray(row.labels), ...parseJsonArray(row.tags)]));

    return {
      id: row.id,
      sessionId: row.sessionId,
      title: row.title,
      content: row.content,
      importance: normalizeImportance(row.importance),
      category: (row.category || "Note") as MemoryCategory,
      unitType: (row.unit_type || "context") as Memory["unitType"],
      labels,
      tags: labels,
      claimStatus: (row.claim_status || "asserted") as Memory["claimStatus"],
      evolvesFromId: row.evolves_from_id || undefined,
      evolvesRelation: (row.evolves_relation || undefined) as Memory["evolvesRelation"],
      isLatest: row.is_latest === 1,
      source: row.source || "manual",
      sourceApp: row.source_app || undefined,
      temporalContext: row.temporal_context || "timeless",
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  /** Keeps the keyword index in step with the row in `memories`. */
  private syncFts(id: string, title: string, content: string, labels: string[]): void {
    this.db.prepare("DELETE FROM fts_memories WHERE memory_id = ?").run(id);
    this.db.prepare(`
      INSERT INTO fts_memories (memory_id, title, content, labels)
      VALUES (?, ?, ?, ?)
    `).run(id, title, content, labels.join(" "));
  }

  async createMemory(memory: Partial<Memory> & { content: string; sessionId: string }): Promise<Memory> {
    const id = memory.id || `mem_${uuidv4()}`;

    // Callers may supply the id so an edit can be replayed as a create.
    if (await this.getMemory(id)) {
      return (await this.updateMemory(id, memory))!;
    }

    const now = new Date().toISOString();
    const title = memory.title || deriveTitle(memory.content);
    const labels = memory.labels || memory.tags || [];
    const labelsJson = JSON.stringify(labels);

    // The insert and the retirement it triggers go in together: applying only
    // one of them leaves two revisions of the same claim both marked latest.
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (
          id, sessionId, title, content, importance, category, unit_type,
          labels, tags, claim_status, evolves_from_id, evolves_relation,
          is_latest, source, source_app, temporal_context, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        memory.sessionId,
        title,
        memory.content,
        normalizeImportance(memory.importance),
        memory.category || "Note",
        memory.unitType || "context",
        labelsJson,
        labelsJson,
        memory.claimStatus || "asserted",
        memory.evolvesFromId || null,
        memory.evolvesRelation || null,
        memory.isLatest === false ? 0 : 1,
        memory.source || "manual",
        memory.sourceApp || null,
        memory.temporalContext || "timeless",
        now,
        now
      );

      // A replacement retires what it supersedes, so an is_latest filter returns
      // one row per claim rather than every revision of it.
      if (memory.evolvesFromId && memory.evolvesRelation === "replaces") {
        this.db.prepare("UPDATE memories SET is_latest = 0 WHERE id = ?").run(memory.evolvesFromId);
      }
    })();

    this.syncFts(id, title, memory.content, labels);

    return (await this.getMemory(id))!;
  }

  async getMemories(
    sessionId?: string,
    filters?: {
      importance?: string | number;
      category?: string;
      query?: string;
      unitType?: string;
      limit?: number;
      includeSuperseded?: boolean;
    }
  ): Promise<Memory[]> {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params: any[] = [];

    // A superseded memory is history, not current knowledge — a reader asking
    // what the project believes now must not be handed the claim it replaced.
    if (!filters?.includeSuperseded) {
      sql += " AND is_latest = 1";
    }

    if (sessionId && sessionId !== "all") {
      sql += " AND sessionId = ?";
      params.push(sessionId);
    }

    if (filters?.unitType) {
      sql += " AND unit_type = ?";
      params.push(filters.unitType);
    }

    if (filters?.category) {
      sql += " AND category = ?";
      params.push(filters.category);
    }

    if (filters?.importance !== undefined) {
      sql += " AND importance >= ?";
      params.push(normalizeImportance(filters.importance));
    }

    if (filters?.query) {
      const like = `LIKE ? ESCAPE '${LIKE_ESCAPE}'`;
      sql += ` AND (title ${like} OR content ${like} OR labels ${like})`;
      const pattern = `%${escapeLike(filters.query)}%`;
      params.push(pattern, pattern, pattern);
    }

    sql += " ORDER BY importance DESC, updatedAt DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.mapMemory(r));
  }

  async getMemory(id: string): Promise<Memory | null> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? this.mapMemory(row) : null;
  }

  async updateMemory(id: string, update: Partial<Memory>): Promise<Memory | null> {
    const existing = await this.getMemory(id);
    if (!existing) return null;

    const pick = <K extends keyof Memory>(key: K): Memory[K] =>
      update[key] !== undefined ? (update[key] as Memory[K]) : existing[key];

    const title = pick("title");
    const content = pick("content");
    const labels = update.labels !== undefined
      ? update.labels
      : (update.tags !== undefined ? update.tags : existing.labels);
    const labelsJson = JSON.stringify(labels);

    this.db.prepare(`
      UPDATE memories SET
        title = ?,
        content = ?,
        importance = ?,
        category = ?,
        unit_type = ?,
        labels = ?,
        tags = ?,
        claim_status = ?,
        evolves_from_id = ?,
        evolves_relation = ?,
        is_latest = ?,
        source = ?,
        source_app = ?,
        temporal_context = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      title,
      content,
      update.importance !== undefined ? normalizeImportance(update.importance) : existing.importance,
      pick("category"),
      pick("unitType"),
      labelsJson,
      labelsJson,
      pick("claimStatus"),
      pick("evolvesFromId") || null,
      pick("evolvesRelation") || null,
      pick("isLatest") === false ? 0 : 1,
      pick("source"),
      pick("sourceApp") || null,
      pick("temporalContext"),
      new Date().toISOString(),
      id
    );

    this.syncFts(id, title, content, labels);

    return this.getMemory(id);
  }

  async deleteMemory(id: string): Promise<boolean> {
    // memory_relations cascades on both of its foreign keys, so the links into
    // and out of this memory go with it.
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM fts_memories WHERE memory_id = ?").run(id);
    return result.changes > 0;
  }

  private mapRelation(row: any): MemoryRelation {
    return {
      id: row.id,
      sourceMemoryId: row.source_memory_id,
      targetMemoryId: row.target_memory_id,
      relationType: row.relation_type,
      reason: row.reason || undefined,
      strength: typeof row.strength === "number" ? row.strength : 1,
      confidence: typeof row.confidence === "number" ? row.confidence : 1,
      bidirectional: row.bidirectional === 1,
      status: (row.status || "active") as MemoryRelation["status"],
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  async addRelation(relation: {
    sourceMemoryId: string;
    targetMemoryId: string;
    relationType: string;
    reason?: string;
    strength?: number;
    confidence?: number;
    bidirectional?: boolean;
    status?: "active" | "suggested";
  }): Promise<MemoryRelation> {
    const id = `rel_${uuidv4()}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO memory_relations (
        id, source_memory_id, target_memory_id, relation_type,
        reason, strength, confidence, bidirectional, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      relation.sourceMemoryId,
      relation.targetMemoryId,
      relation.relationType,
      relation.reason || null,
      relation.strength !== undefined ? relation.strength : 1,
      relation.confidence !== undefined ? relation.confidence : 1,
      relation.bidirectional ? 1 : 0,
      relation.status || "active",
      now,
      now
    );

    return this.mapRelation(this.db.prepare("SELECT * FROM memory_relations WHERE id = ?").get(id));
  }

  async listRelations(
    memoryId: string,
    options?: { direction?: "out" | "in" | "both"; relationTypes?: string[]; status?: string; limit?: number }
  ): Promise<MemoryRelation[]> {
    const direction = options?.direction || "both";

    let sql = "SELECT * FROM memory_relations WHERE status = ?";
    const params: any[] = [options?.status || "active"];

    if (direction === "out") {
      sql += " AND source_memory_id = ?";
      params.push(memoryId);
    } else if (direction === "in") {
      // A bidirectional link points back at its source as well.
      sql += " AND (target_memory_id = ? OR (source_memory_id = ? AND bidirectional = 1))";
      params.push(memoryId, memoryId);
    } else {
      sql += " AND (source_memory_id = ? OR target_memory_id = ?)";
      params.push(memoryId, memoryId);
    }

    if (options?.relationTypes && options.relationTypes.length > 0) {
      sql += ` AND relation_type IN (${options.relationTypes.map(() => "?").join(",")})`;
      params.push(...options.relationTypes);
    }

    sql += " ORDER BY strength DESC, updatedAt DESC LIMIT ?";
    params.push(options?.limit || 50);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.mapRelation(r));
  }

  async deleteRelation(relationId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM memory_relations WHERE id = ?").run(relationId).changes > 0;
  }

  /**
   * Returns every revision of a claim the given memory belongs to, oldest
   * first, together with where in that chain the memory itself sits.
   *
   * Both walks record the ids they have already seen. Nothing here writes a
   * loop, but an imported or hand-edited row can hold one, and following it
   * blind would spin forever rather than returning a short chain.
   */
  async getEvolutionChain(memoryId: string, maxDepth: number = 10): Promise<{
    chain: MemoryRevision[];
    position: number;
    totalVersions: number;
  }> {
    const root = await this.getMemory(memoryId);
    if (!root) throw new Error(`Memory ${memoryId} not found`);

    const visited = new Set<string>([root.id]);

    const ancestors: Memory[] = [];
    let olderId = root.evolvesFromId;
    while (olderId && !visited.has(olderId) && ancestors.length < maxDepth) {
      const ancestor = await this.getMemory(olderId);
      if (!ancestor) break;
      visited.add(ancestor.id);
      ancestors.unshift(ancestor);
      olderId = ancestor.evolvesFromId;
    }

    const descendants: Memory[] = [];
    let newerOf = root.id;
    while (descendants.length < maxDepth) {
      const row = this.db.prepare("SELECT * FROM memories WHERE evolves_from_id = ?").get(newerOf) as any;
      if (!row || visited.has(row.id)) break;
      const descendant = this.mapMemory(row);
      visited.add(descendant.id);
      descendants.push(descendant);
      newerOf = descendant.id;
    }

    const chain = [...ancestors, root, ...descendants];

    return {
      chain: chain.map(m => ({
        id: m.id,
        title: m.title,
        unitType: m.unitType,
        isLatest: m.isLatest === true,
        createdAt: m.createdAt.toISOString(),
        evolvesFromId: m.evolvesFromId,
        evolvesRelation: m.evolvesRelation
      })),
      position: ancestors.length,
      totalVersions: chain.length
    };
  }

  /**
   * Records that one memory replaced another. Retiring the old row, linking
   * the new one to it and writing the typed link happen together: a supersede
   * that lands halfway leaves both memories claiming to be current, which is
   * exactly the state the is_latest filter exists to prevent.
   *
   * Only the evolution columns change, so fts_memories stays as it is.
   */
  async supersedeMemory(oldMemoryId: string, newMemoryId: string, reason?: string): Promise<{
    status: string;
    oldMemory: { id: string; isLatest: boolean };
    newMemory: { id: string; isLatest: boolean; evolvesFromId: string };
  }> {
    if (oldMemoryId === newMemoryId) {
      throw new Error("A memory cannot supersede itself");
    }
    if (!(await this.getMemory(oldMemoryId))) {
      throw new Error(`Memory ${oldMemoryId} not found`);
    }
    if (!(await this.getMemory(newMemoryId))) {
      throw new Error(`Memory ${newMemoryId} not found`);
    }

    const now = new Date().toISOString();
    const relationId = `rel_${uuidv4()}`;

    this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET is_latest = 0, updatedAt = ? WHERE id = ?")
        .run(now, oldMemoryId);

      this.db.prepare(`
        UPDATE memories SET
          evolves_from_id = ?,
          evolves_relation = 'replaces',
          is_latest = 1,
          updatedAt = ?
        WHERE id = ?
      `).run(oldMemoryId, now, newMemoryId);

      // The same fact as a typed link, so relation queries see the supersede.
      this.db.prepare(`
        INSERT INTO memory_relations (
          id, source_memory_id, target_memory_id, relation_type,
          reason, strength, confidence, bidirectional, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, 'replaces', ?, 1, 1, 0, 'active', ?, ?)
      `).run(relationId, newMemoryId, oldMemoryId, reason || null, now, now);
    })();

    return {
      status: "superseded",
      oldMemory: { id: oldMemoryId, isLatest: false },
      newMemory: { id: newMemoryId, isLatest: true, evolvesFromId: oldMemoryId }
    };
  }

  async getWorkingMemory(sessionId: string): Promise<WorkingMemory | null> {
    const row = this.db.prepare("SELECT * FROM working_memory WHERE sessionId = ?").get(sessionId) as any;
    if (!row) return null;

    return {
      sessionId: row.sessionId,
      briefing: row.briefing || "",
      focusAreas: parseJsonArray(row.focusAreas),
      activeDecisions: parseJsonArray(row.activeDecisions),
      blockers: parseJsonArray(row.blockers),
      lastGeneratedAt: new Date(row.lastGeneratedAt || row.updatedAt),
      updatedAt: new Date(row.updatedAt)
    };
  }

  async saveWorkingMemory(workingMemory: Partial<WorkingMemory> & { sessionId: string }): Promise<WorkingMemory> {
    const now = new Date().toISOString();

    // The dashboard and the MCP tool each save a subset of the briefing, so a
    // field the caller left out keeps its stored value instead of being blanked.
    const existing = await this.getWorkingMemory(workingMemory.sessionId);
    const merge = <K extends keyof WorkingMemory>(key: K, fallback: WorkingMemory[K]): WorkingMemory[K] => {
      if (workingMemory[key] !== undefined) return workingMemory[key] as WorkingMemory[K];
      return existing ? existing[key] : fallback;
    };

    this.db.prepare(`
      INSERT INTO working_memory (sessionId, briefing, focusAreas, activeDecisions, blockers, lastGeneratedAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        briefing = excluded.briefing,
        focusAreas = excluded.focusAreas,
        activeDecisions = excluded.activeDecisions,
        blockers = excluded.blockers,
        lastGeneratedAt = excluded.lastGeneratedAt,
        updatedAt = excluded.updatedAt
    `).run(
      workingMemory.sessionId,
      merge("briefing", ""),
      JSON.stringify(merge("focusAreas", [])),
      JSON.stringify(merge("activeDecisions", [])),
      JSON.stringify(merge("blockers", [])),
      merge("lastGeneratedAt", new Date(now)).toISOString(),
      now
    );

    return (await this.getWorkingMemory(workingMemory.sessionId))!;
  }
}
