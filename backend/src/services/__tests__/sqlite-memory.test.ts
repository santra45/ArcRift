import Database from "better-sqlite3";
import fs from "fs";
import { SqliteMemoryStore } from "../sqlite-memory";
import { SqliteSessionStore } from "../sqlite-session";
import { initSqlite, getSqlite } from "../sqlite";
import { IMPORTANCE_LEVELS, importanceToScore } from "../../utils/importance";

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
      expect(created.importance).toBe(importanceToScore("critical"));
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
      expect(importances[0]).toBe(importanceToScore("critical"));
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

  describe("importance filter", () => {
    let importanceSessionId: string;

    beforeAll(async () => {
      const session = await sessionStore.createSession("Importance Project", "chrome");
      importanceSessionId = session._id;

      // Written the way store_memory writes them, so the filter is exercised
      // against real stored scores rather than hand-picked numbers.
      for (const level of IMPORTANCE_LEVELS) {
        await memoryStore.createMemory({
          sessionId: importanceSessionId,
          content: `A ${level} memory.`,
          importance: importanceToScore(level)
        });
      }
    });

    it.each(IMPORTANCE_LEVELS)("returns a memory saved as %s when filtering for it", async level => {
      const results = await memoryStore.getMemories(importanceSessionId, { importance: level });
      expect(results.map(m => m.content)).toContain(`A ${level} memory.`);
    });

    it("filters as a threshold, not an exact match", async () => {
      const results = await memoryStore.getMemories(importanceSessionId, { importance: "high" });
      const contents = results.map(m => m.content);
      expect(contents).toContain("A critical memory.");
      expect(contents).not.toContain("A medium memory.");
    });
  });

  describe("memory relations", () => {
    let relationSessionId: string;
    let symptomId: string;
    let fixId: string;

    beforeAll(async () => {
      const session = await sessionStore.createSession("Relations Project", "chrome");
      relationSessionId = session._id;

      symptomId = (await memoryStore.createMemory({
        sessionId: relationSessionId,
        content: "The API returns 429 under load."
      })).id;
      fixId = (await memoryStore.createMemory({
        sessionId: relationSessionId,
        content: "Requests are batched to stay under the rate limit."
      })).id;
    });

    it("adds, lists and deletes a typed link", async () => {
      const relation = await memoryStore.addRelation({
        sourceMemoryId: fixId,
        targetMemoryId: symptomId,
        relationType: "caused_by",
        reason: "The batching exists because of the 429s."
      });

      expect(relation.relationType).toBe("caused_by");
      expect(relation.strength).toBe(1);
      expect(relation.confidence).toBe(1);
      expect(relation.bidirectional).toBe(false);
      expect(relation.status).toBe("active");

      // The same link is outgoing at one end and incoming at the other.
      expect((await memoryStore.listRelations(fixId, { direction: "out" })).map(r => r.id)).toEqual([relation.id]);
      expect((await memoryStore.listRelations(symptomId, { direction: "in" })).map(r => r.id)).toEqual([relation.id]);
      expect((await memoryStore.listRelations(symptomId)).map(r => r.id)).toEqual([relation.id]);
      expect(await memoryStore.listRelations(symptomId, { direction: "out" })).toEqual([]);

      expect(await memoryStore.deleteRelation(relation.id)).toBe(true);
      expect(await memoryStore.listRelations(fixId)).toEqual([]);
      expect(await memoryStore.deleteRelation(relation.id)).toBe(false);
    });

    it("filters by relation type", async () => {
      const refines = await memoryStore.addRelation({
        sourceMemoryId: fixId, targetMemoryId: symptomId, relationType: "refines"
      });
      const contradicts = await memoryStore.addRelation({
        sourceMemoryId: fixId, targetMemoryId: symptomId, relationType: "contradicts"
      });

      const matched = await memoryStore.listRelations(fixId, { relationTypes: ["contradicts"] });
      expect(matched.map(r => r.id)).toEqual([contradicts.id]);

      await memoryStore.deleteRelation(refines.id);
      await memoryStore.deleteRelation(contradicts.id);
    });

    it("removes a memory's relations along with the memory", async () => {
      const doomed = await memoryStore.createMemory({
        sessionId: relationSessionId,
        content: "Linked to by something that outlives it."
      });
      const relation = await memoryStore.addRelation({
        sourceMemoryId: symptomId,
        targetMemoryId: doomed.id,
        relationType: "refines"
      });

      await memoryStore.deleteMemory(doomed.id);

      const remaining = db.prepare("SELECT COUNT(*) n FROM memory_relations WHERE id = ?").get(relation.id);
      expect(remaining.n).toBe(0);
    });
  });

  describe("memory evolution", () => {
    let evolutionSessionId: string;

    const remember = (content: string) =>
      memoryStore.createMemory({ sessionId: evolutionSessionId, content });

    beforeAll(async () => {
      const session = await sessionStore.createSession("Evolution Project", "chrome");
      evolutionSessionId = session._id;
    });

    it("retires the old memory and links its replacement", async () => {
      const older = await remember("Deploys go out on Fridays.");
      const newer = await remember("Deploys go out on Tuesdays.");

      const result = await memoryStore.supersedeMemory(older.id, newer.id, "Friday deploys kept breaking.");
      expect(result.status).toBe("superseded");

      expect((await memoryStore.getMemory(older.id))?.isLatest).toBe(false);

      const current = await memoryStore.getMemory(newer.id);
      expect(current?.isLatest).toBe(true);
      expect(current?.evolvesFromId).toBe(older.id);
      expect(current?.evolvesRelation).toBe("replaces");

      // The supersede is recorded as a typed link too.
      const links = await memoryStore.listRelations(newer.id, { direction: "out" });
      expect(links).toHaveLength(1);
      expect(links[0].relationType).toBe("replaces");
      expect(links[0].targetMemoryId).toBe(older.id);
      expect(links[0].reason).toBe("Friday deploys kept breaking.");
    });

    it("refuses a supersede that names a missing memory or itself", async () => {
      const current = await remember("Nothing has replaced this yet.");

      await expect(memoryStore.supersedeMemory("mem_missing", current.id)).rejects.toThrow(/not found/);
      await expect(memoryStore.supersedeMemory(current.id, "mem_missing")).rejects.toThrow(/not found/);
      await expect(memoryStore.supersedeMemory(current.id, current.id)).rejects.toThrow(/itself/);
    });

    it("rolls the whole supersede back when part of it fails", async () => {
      const older = await remember("The cache lives in Redis.");
      const newer = await remember("The cache lives in Postgres.");

      // Blocking the relation insert — the last of the three writes — shows the
      // two memory updates before it are undone with it.
      db.exec(
        "CREATE TRIGGER block_relations BEFORE INSERT ON memory_relations " +
        "BEGIN SELECT RAISE(ABORT, 'blocked'); END"
      );

      // Caught by hand — expect().rejects does not reliably recognise the error
      // class better-sqlite3 raises as a throw.
      let error: any;
      try {
        await memoryStore.supersedeMemory(older.id, newer.id);
      } catch (err) {
        error = err;
      } finally {
        db.exec("DROP TRIGGER block_relations");
      }

      expect(error?.message).toContain("blocked");
      expect((await memoryStore.getMemory(older.id))?.isLatest).toBe(true);
      expect((await memoryStore.getMemory(newer.id))?.evolvesFromId).toBeUndefined();
      expect(await memoryStore.listRelations(newer.id, { direction: "out" })).toEqual([]);
    });

    it("retires the earlier memory when a replacement is created outright", async () => {
      const original = await remember("Logs go to stdout.");
      const replacement = await memoryStore.createMemory({
        sessionId: evolutionSessionId,
        content: "Logs go to a rotating file.",
        evolvesFromId: original.id,
        evolvesRelation: "replaces"
      });

      expect(replacement.evolvesFromId).toBe(original.id);
      expect((await memoryStore.getMemory(original.id))?.isLatest).toBe(false);
    });

    it("walks the chain oldest first", async () => {
      const v1 = await remember("Hosted on Heroku.");
      const v2 = await remember("Hosted on Fly.io.");
      const v3 = await remember("Hosted on Railway.");

      await memoryStore.supersedeMemory(v1.id, v2.id);
      await memoryStore.supersedeMemory(v2.id, v3.id);

      const fromMiddle = await memoryStore.getEvolutionChain(v2.id);
      expect(fromMiddle.chain.map(c => c.id)).toEqual([v1.id, v2.id, v3.id]);
      expect(fromMiddle.chain.map(c => c.isLatest)).toEqual([false, false, true]);
      expect(fromMiddle.position).toBe(1);
      expect(fromMiddle.totalVersions).toBe(3);

      // Either end of the chain sees the same revisions.
      expect((await memoryStore.getEvolutionChain(v1.id)).chain.map(c => c.id)).toEqual([v1.id, v2.id, v3.id]);
      expect((await memoryStore.getEvolutionChain(v3.id)).position).toBe(2);
    });

    it("stops at maxDepth on a long chain", async () => {
      const first = await remember("Step one.");
      let previous = first;
      for (let i = 2; i <= 5; i++) {
        const next = await remember(`Step ${i}.`);
        await memoryStore.supersedeMemory(previous.id, next.id);
        previous = next;
      }

      expect((await memoryStore.getEvolutionChain(first.id, 2)).totalVersions).toBe(3);
    });

    it("terminates on a chain that loops back on itself", async () => {
      const a = await remember("Cycle: first half.");
      const b = await remember("Cycle: second half.");

      // Nothing in the store writes a loop, but an imported or hand-edited row can.
      db.prepare("UPDATE memories SET evolves_from_id = ? WHERE id = ?").run(b.id, a.id);
      db.prepare("UPDATE memories SET evolves_from_id = ? WHERE id = ?").run(a.id, b.id);

      const chain = await memoryStore.getEvolutionChain(a.id, 100);
      expect(chain.chain.map(c => c.id)).toEqual([b.id, a.id]);
      expect(chain.totalVersions).toBe(2);
    });
  });

  describe("superseded memories in reads", () => {
    let historySessionId: string;
    let oldId: string;
    let newId: string;

    beforeAll(async () => {
      const session = await sessionStore.createSession("History Project", "chrome");
      historySessionId = session._id;

      oldId = (await memoryStore.createMemory({
        sessionId: historySessionId,
        content: "The rate limit is 100 requests a minute."
      })).id;
      newId = (await memoryStore.createMemory({
        sessionId: historySessionId,
        content: "The rate limit is 500 requests a minute."
      })).id;

      await memoryStore.supersedeMemory(oldId, newId);
    });

    it("returns only the current memory by default", async () => {
      expect((await memoryStore.getMemories(historySessionId)).map(m => m.id)).toEqual([newId]);
      // Still readable by ID — superseded is history, not deleted.
      expect(await memoryStore.getMemory(oldId)).not.toBeNull();
    });

    it("does not resurrect a superseded memory through another filter", async () => {
      const matched = await memoryStore.getMemories(historySessionId, { query: "rate limit" });
      expect(matched.map(m => m.id)).toEqual([newId]);
    });

    it("returns the superseded memory when the history is asked for", async () => {
      const all = await memoryStore.getMemories(historySessionId, { includeSuperseded: true });
      expect(all.map(m => m.id).sort()).toEqual([newId, oldId].sort());
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
