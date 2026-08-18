import { v4 as uuidv4 } from "uuid";
import { getSqlite } from "./sqlite";
import { IMemoryStore, Memory, MemoryCategory, WorkingMemory } from "./storage.types";

/**
 * Importance is a REAL column, but callers still hand us the old level names
 * (REST query strings, MCP arguments, imported records). Anything we cannot
 * read falls back to the column default rather than writing NULL.
 */
function normalizeImportance(value: unknown): number {
  if (typeof value === "number") return clampImportance(value);

  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "critical": return 1.0;
      case "high": return 0.8;
      case "medium": return 0.5;
      case "low": return 0.2;
    }
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
    }
  ): Promise<Memory[]> {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params: any[] = [];

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
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM fts_memories WHERE memory_id = ?").run(id);
    return result.changes > 0;
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
