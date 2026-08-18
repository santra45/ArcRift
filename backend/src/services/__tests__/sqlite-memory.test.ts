import Database from "better-sqlite3";
import fs from "fs";
import { SqliteMemoryStore } from "../sqlite-memory";
import { SqliteSessionStore } from "../sqlite-session";
import { initSqlite, getSqlite } from "../sqlite";

// Deliberately not the filename the storage suite uses — the two run in
// separate workers and would otherwise fight over the same database.
const TEST_DB = "test-memory.db";
const DB_FILES = [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`];

let uuidCounter = 0;
jest.mock("uuid", () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}));

function removeDbFiles() {
  for (const f of DB_FILES) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe("SqliteMemoryStore", () => {
  let db: any;
  let memoryStore: SqliteMemoryStore;
  let sessionStore: SqliteSessionStore;
  let sessionId: string;

  beforeAll(async () => {
    process.env.SQLITE_DB_PATH = TEST_DB;
    // Start from an empty file. The uuid mock hands out the same IDs every run,
    // so a database left behind by the previous run fails each insert on its
    // UNIQUE constraint.
    removeDbFiles();
    initSqlite();
    db = getSqlite();
    memoryStore = new SqliteMemoryStore();
    sessionStore = new SqliteSessionStore();

    const session = await sessionStore.createSession("Memory Project", "chrome");
    sessionId = session._id;
  });

  describe("CRUD", () => {
    let memoryId: string;

    it("creates a memory and reads it back", async () => {
      const created = await memoryStore.createMemory({
        sessionId,
        title: "Use SQLite",
        content: "The zero-Docker mode stores everything in a single file.",
        importance: 0.8,
        category: "Decision",
        unitType: "decision",
        labels: ["storage"]
      });

      memoryId = created.id;
      expect(created.title).toBe("Use SQLite");
      expect(created.importance).toBe(0.8);
      expect(created.category).toBe("Decision");
      expect(created.unitType).toBe("decision");
      expect(created.labels).toEqual(["storage"]);
      // labels and tags are the same list.
      expect(created.tags).toEqual(["storage"]);
      expect(created.isLatest).toBe(true);

      const fetched = await memoryStore.getMemory(memoryId);
      expect(fetched?.content).toBe(created.content);
    });

    it("derives a title from the content when none is given", async () => {
      const created = await memoryStore.createMemory({
        sessionId,
        content: "x".repeat(80)
      });
      expect(created.title).toBe(`${"x".repeat(50)}...`);
    });

    it("accepts the legacy importance level names", async () => {
      const created = await memoryStore.createMemory({
        sessionId,
        content: "Imported from an older export.",
        importance: "critical" as any
      });
      expect(created.importance).toBe(1);
    });

    it("updates only the fields it is given", async () => {
      const updated = await memoryStore.updateMemory(memoryId, { importance: 0.4 });
      expect(updated?.importance).toBe(0.4);
      expect(updated?.title).toBe("Use SQLite");
      expect(updated?.labels).toEqual(["storage"]);
    });

    it("returns null when updating a memory that does not exist", async () => {
      expect(await memoryStore.updateMemory("mem_missing", { title: "Nope" })).toBeNull();
    });

    it("deletes a memory and reports whether anything was removed", async () => {
      const doomed = await memoryStore.createMemory({ sessionId, content: "Temporary note." });

      expect(await memoryStore.deleteMemory(doomed.id)).toBe(true);
      expect(await memoryStore.getMemory(doomed.id)).toBeNull();
      expect(await memoryStore.deleteMemory(doomed.id)).toBe(false);
    });

    it("orders memories by importance", async () => {
      const ordered = await memoryStore.getMemories(sessionId);
      const importances = ordered.map(m => m.importance);
      expect(importances).toEqual([...importances].sort((a, b) => b - a));
      expect(importances[0]).toBe(1);
    });

    it("filters by a minimum importance", async () => {
      const important = await memoryStore.getMemories(sessionId, { importance: 0.9 });
      expect(important.every(m => m.importance >= 0.9)).toBe(true);
      expect(important.length).toBeGreaterThan(0);
    });
  });

  describe("keyword index", () => {
    it("keeps fts_memories in step with writes", async () => {
      const created = await memoryStore.createMemory({
        sessionId,
        title: "Indexed title",
        content: "Indexed body text."
      });

      const ftsRow = () => db.prepare("SELECT * FROM fts_memories WHERE memory_id = ?").get(created.id);
      expect(ftsRow().content).toBe("Indexed body text.");

      await memoryStore.updateMemory(created.id, { content: "Rewritten body text." });
      expect(ftsRow().content).toBe("Rewritten body text.");
      // The update must replace the row, not add a second one.
      const rows = db.prepare("SELECT COUNT(*) n FROM fts_memories WHERE memory_id = ?").get(created.id);
      expect(rows.n).toBe(1);

      await memoryStore.deleteMemory(created.id);
      expect(ftsRow()).toBeUndefined();
    });
  });

  // LIKE reads % and _ as wildcards, so an unescaped query matched rows that
  // did not contain the caller's text at all.
  describe("query filter escaping", () => {
    let escapeSessionId: string;

    beforeAll(async () => {
      const session = await sessionStore.createSession("Escaping Project", "chrome");
      escapeSessionId = session._id;

      await memoryStore.createMemory({ sessionId: escapeSessionId, content: "Reads the user_id column." });
      await memoryStore.createMemory({ sessionId: escapeSessionId, content: "Reads the userXid column." });
      await memoryStore.createMemory({ sessionId: escapeSessionId, content: "Coverage is at 100% now." });
      await memoryStore.createMemory({ sessionId: escapeSessionId, content: "Nothing numeric here." });
    });

    it("treats _ as a literal character", async () => {
      const results = await memoryStore.getMemories(escapeSessionId, { query: "user_id" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("user_id");
    });

    it("treats % as a literal character", async () => {
      const results = await memoryStore.getMemories(escapeSessionId, { query: "100%" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("100%");
    });

    it("does not let a bare % match everything", async () => {
      expect(await memoryStore.getMemories(escapeSessionId, { query: "%" })).toHaveLength(1);
    });

    it("still matches an ordinary substring", async () => {
      const results = await memoryStore.getMemories(escapeSessionId, { query: "Reads the" });
      expect(results).toHaveLength(2);
    });
  });

  describe("working memory", () => {
    it("returns null before anything is saved", async () => {
      expect(await memoryStore.getWorkingMemory(sessionId)).toBeNull();
    });

    it("saves and reads a briefing back", async () => {
      const saved = await memoryStore.saveWorkingMemory({
        sessionId,
        briefing: "Porting the memory layer.",
        focusAreas: ["schema", "store"],
        activeDecisions: ["SQLite only"],
        blockers: []
      });

      expect(saved.briefing).toBe("Porting the memory layer.");
      expect(saved.focusAreas).toEqual(["schema", "store"]);
      expect(saved.activeDecisions).toEqual(["SQLite only"]);
      expect(saved.blockers).toEqual([]);
    });

    it("upserts rather than duplicating the row", async () => {
      await memoryStore.saveWorkingMemory({ sessionId, briefing: "Second pass." });

      const rows = db.prepare("SELECT COUNT(*) n FROM working_memory WHERE sessionId = ?").get(sessionId);
      expect(rows.n).toBe(1);

      const current = await memoryStore.getWorkingMemory(sessionId);
      expect(current?.briefing).toBe("Second pass.");
      // A partial save keeps the fields it did not mention.
      expect(current?.focusAreas).toEqual(["schema", "store"]);
    });
  });

  describe("session cascade", () => {
    it("removes a session's memories and briefing with the session", async () => {
      const session = await sessionStore.createSession("Doomed Project", "chrome");
      const memory = await memoryStore.createMemory({
        sessionId: session._id,
        content: "Belongs to a session that is about to go away."
      });
      await memoryStore.saveWorkingMemory({ sessionId: session._id, briefing: "Short lived." });

      await sessionStore.deleteSession(session._id);

      expect(await memoryStore.getMemory(memory.id)).toBeNull();
      expect(await memoryStore.getWorkingMemory(session._id)).toBeNull();
    });
  });
});

// The additive migration is the only upgrade path for databases created before
// the classification columns existed, so it is exercised against a real one.
describe("memories schema migration", () => {
  const LEGACY_DB = "test-memory-legacy.db";
  const LEGACY_FILES = [LEGACY_DB, `${LEGACY_DB}-wal`, `${LEGACY_DB}-shm`];

  afterAll(() => {
    for (const f of LEGACY_FILES) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("adds the missing columns to a pre-migration database", () => {
    for (const f of LEGACY_FILES) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    const legacy = new Database(LEGACY_DB);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        category TEXT DEFAULT 'Note',
        tags TEXT,
        source TEXT DEFAULT 'manual',
        createdAt TEXT,
        updatedAt TEXT
      )
    `);
    legacy.prepare(
      "INSERT INTO memories (id, sessionId, title, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("mem_legacy", "legacy-session", "Old row", "Written before the migration.", "2026-01-01", "2026-01-01");
    legacy.close();

    process.env.SQLITE_DB_PATH = LEGACY_DB;
    jest.isolateModules(() => {
      const { initSqlite: init, getSqlite: get } = require("../sqlite");
      init();

      const columns = (get().prepare("PRAGMA table_info(memories)").all() as any[]).map(c => c.name);
      for (const col of [
        "unit_type", "labels", "claim_status", "evolves_from_id",
        "evolves_relation", "is_latest", "source_app", "temporal_context"
      ]) {
        expect(columns).toContain(col);
      }

      // The existing row survives and picks up the column defaults.
      const row = get().prepare("SELECT * FROM memories WHERE id = ?").get("mem_legacy") as any;
      expect(row.content).toBe("Written before the migration.");
      expect(row.unit_type).toBe("context");
      expect(row.is_latest).toBe(1);

      get().close();
    });

    process.env.SQLITE_DB_PATH = TEST_DB;
  });
});
