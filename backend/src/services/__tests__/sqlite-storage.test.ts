import { SqliteSessionStore } from "../sqlite-session";
import { SqliteGraphStore } from "../sqlite-graph";
import { SqliteVectorStore } from "../sqlite-vector";
import { initSqlite, getSqlite } from "../sqlite";
import * as embeddings from "../embeddings";
import fs from "fs";

const TEST_DB = "test.db";

let uuidCounter = 0;
jest.mock("uuid", () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}));

// Mock the embeddings service to avoid external API calls.
// One vector per input text — returning a fixed single-element array left the
// caller reading past the end as soon as it asked for more than one.
jest.mock("../embeddings", () => ({
  generateEmbedding: jest.fn().mockResolvedValue(new Array(768).fill(0.1)),
  generateEmbeddings: jest.fn((texts: string[]) =>
    Promise.resolve(texts.map(() => new Array(768).fill(0.1)))
  )
}));

describe("SQLite Storage Layer", () => {
  let db: any;
  let sessionStore: SqliteSessionStore;
  let graphStore: SqliteGraphStore;
  let vectorStore: SqliteVectorStore;

  beforeAll(() => {
    process.env.SQLITE_DB_PATH = TEST_DB;
    // Start from an empty file. The uuid mock hands out the same IDs every run,
    // so a database left behind by the previous run failed each insert on its
    // UNIQUE constraint and the suite only passed the first time it was run.
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    initSqlite();
    db = getSqlite();
    sessionStore = new SqliteSessionStore();
    graphStore = new SqliteGraphStore();
    vectorStore = new SqliteVectorStore();
  });

  describe("SqliteSessionStore", () => {
    let sessionId: string;

    it("should create a new session", async () => {
      const session = await sessionStore.createSession("Test Project", "chrome");
      expect(session.projectName).toBe("Test Project");
      expect(session._id).toBeDefined();
      sessionId = session._id;
    });

    it("should retrieve sessions", async () => {
      const sessions = await sessionStore.getSessions();
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].projectName).toBe("Test Project");
    });

    it("should handle active session state", async () => {
      await sessionStore.setActiveSessionId(sessionId);
      const active = await sessionStore.getActiveSessionId();
      expect(active).toBe(sessionId);
    });
  });

  describe("SqliteGraphStore", () => {
    let testSessionId: string;

    beforeAll(async () => {
        const session = await sessionStore.createSession("Graph Project", "chrome");
        testSessionId = session._id;
    });

    it("should save and retrieve triples", async () => {
      const triple = {
        subject: "Noob",
        subjectType: "Person",
        relation: "OWNS",
        object: "SplitSmart",
        objectType: "Project",
        sessionId: testSessionId,
        timestamp: new Date().toISOString()
      };

      await graphStore.saveTriple(triple);
      const triples = await graphStore.getTriplesBySession(testSessionId);
      expect(triples).toHaveLength(1);
      expect(triples[0].subject).toBe("Noob");
    });

    it("should find related triples by entities", async () => {
      const related = await graphStore.findRelatedTriples(["Noob"], testSessionId);
      expect(related).toHaveLength(1);
      expect(related[0].object).toBe("SplitSmart");
    });
  });

  describe("SqliteVectorStore", () => {
    let testSessionId: string;

    beforeAll(async () => {
        const session = await sessionStore.createSession("Vec Project", "chrome");
        testSessionId = session._id;
    });

    it("should store chunks and metadata", async () => {
      const chunks = [
        {
          id: "chunk-1",
          sessionId: testSessionId,
          chunkIndex: 0,
          content: "ArcRift is a local knowledge graph tool."
        }
      ];

      await vectorStore.storeChunks(chunks as any);

      // Verify metadata exists
      const meta = db.prepare("SELECT * FROM chunk_metadata WHERE sessionId = ?").get(testSessionId);
      expect(meta.content).toContain("ArcRift");
    });

    // Re-embedding a whole session on every save is what pushed store_memory
    // past the MCP client's request timeout: a one-turn addition to a long
    // transcript re-embedded every chunk, ~112s on a 200-chunk project.
    describe("incremental indexing", () => {
      let incrementalSessionId: string;
      const chunk = (i: number, content: string) => ({
        id: `${incrementalSessionId}-chunk-${i}`,
        sessionId: incrementalSessionId,
        chunkIndex: i,
        content,
      });

      beforeAll(async () => {
        const session = await sessionStore.createSession("Incremental Project", "chrome");
        incrementalSessionId = session._id;
      });

      beforeEach(() => {
        (embeddings.generateEmbeddings as jest.Mock).mockClear();
      });

      const embeddedCount = () => {
        const calls = (embeddings.generateEmbeddings as jest.Mock).mock.calls;
        return calls.reduce((n, [texts]) => n + texts.length, 0);
      };

      it("embeds every chunk on the first save", async () => {
        await vectorStore.storeChunks([chunk(0, "first topic"), chunk(1, "second topic")] as any);
        expect(embeddedCount()).toBe(2);
      });

      it("embeds only the chunk that changed", async () => {
        await vectorStore.storeChunks([chunk(0, "first topic"), chunk(1, "second topic rewritten")] as any);
        expect(embeddedCount()).toBe(1);
      });

      it("embeds nothing when no chunk changed", async () => {
        await vectorStore.storeChunks([chunk(0, "first topic"), chunk(1, "second topic rewritten")] as any);
        expect(embeddedCount()).toBe(0);
      });

      it("embeds only the appended chunk", async () => {
        await vectorStore.storeChunks([
          chunk(0, "first topic"),
          chunk(1, "second topic rewritten"),
          chunk(2, "third topic"),
        ] as any);
        expect(embeddedCount()).toBe(1);
      });

      it("keeps the stored chunks in step with what was passed in", async () => {
        const rows = db
          .prepare("SELECT chunk_id, content FROM chunk_metadata WHERE sessionId = ? ORDER BY chunkIndex")
          .all(incrementalSessionId);
        expect(rows.map((r: any) => r.content)).toEqual([
          "first topic",
          "second topic rewritten",
          "third topic",
        ]);
      });

      it("drops chunks a later save no longer contains", async () => {
        await vectorStore.storeChunks([chunk(0, "first topic")] as any);

        const rows = db
          .prepare("SELECT chunk_id FROM chunk_metadata WHERE sessionId = ?")
          .all(incrementalSessionId);
        expect(rows).toHaveLength(1);

        // Nothing may be left pointing at the removed chunks.
        const orphanVectors = db
          .prepare("SELECT COUNT(*) n FROM vec_chunks v WHERE NOT EXISTS (SELECT 1 FROM chunk_metadata m WHERE m.chunk_id = v.chunk_id)")
          .get();
        const orphanKeywords = db
          .prepare("SELECT COUNT(*) n FROM fts_chunks f WHERE NOT EXISTS (SELECT 1 FROM chunk_metadata m WHERE m.chunk_id = f.chunk_id)")
          .get();
        expect(orphanVectors.n).toBe(0);
        expect(orphanKeywords.n).toBe(0);
      });
    });
  });
});
