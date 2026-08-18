/**
 * store.test.ts — the store_memory tool against a real SQLite database.
 *
 * Covers the memory card store_memory records alongside the transcript.
 */

import fs from "fs";

// A database of this suite's own, emptied first: the tool writes through the
// storage singletons, which open whatever SQLITE_DB_PATH names at import time.
const TEST_DB = "test-store-tool.db";

process.env.ARCRIFT_STORAGE_MODE = "sqlite";
process.env.SQLITE_DB_PATH = TEST_DB;

for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

import { memoryStore, sessionStore } from "../../../services/storage";
import { ImportanceLevel } from "../importance";
import { store } from "../store";

// Indexing the transcript would otherwise call the embedding backend.
jest.mock("../../../services/embeddings", () => ({
  generateEmbedding: jest.fn().mockResolvedValue(new Array(768).fill(0.1)),
  generateEmbeddings: jest.fn((texts: string[]) =>
    Promise.resolve(texts.map(() => new Array(768).fill(0.1)))
  )
}));

describe("store_memory", () => {
  let projectCounter = 0;

  // A project of its own per test: saves against the same project merge into
  // one transcript, and a repeat of stored text is deliberately a no-op.
  const newProject = () => `Store Tool Project ${++projectCounter}`;

  const cardsFor = async (project: string) => {
    const session = await sessionStore.getSessionByName(project);
    return memoryStore.getMemories(session!._id);
  };

  it("records a memory card for new content", async () => {
    const project = newProject();
    const result = await store("The retry budget is three attempts.", project);

    expect(result).toContain("Successfully stored memory");
    expect(result).toContain('Memory Card Created: "The retry budget is three attempts." [HIGH, Note]');

    const cards = await cardsFor(project);
    expect(cards).toHaveLength(1);
    expect(cards[0].content).toBe("The retry budget is three attempts.");
    expect(cards[0].importance).toBe(0.75);
    expect(cards[0].category).toBe("Note");
    expect(cards[0].source).toBe("mcp");
  });

  it("files the card under the category and tags it is given", async () => {
    const project = newProject();
    await store("Retries use exponential backoff.", project, "critical", "Rule", undefined, ["retries", "http"]);

    const [card] = await cardsFor(project);
    expect(card.category).toBe("Rule");
    expect(card.importance).toBe(0.95);
    expect(card.tags).toEqual(["retries", "http"]);
  });

  it("does not record a second card when the save adds nothing", async () => {
    const project = newProject();
    const content = "Deploys are cut from main on Tuesdays.";

    await store(content, project);
    const repeat = await store(content, project);

    expect(repeat).toContain("Nothing to add");
    expect(await cardsFor(project)).toHaveLength(1);
  });

  it("titles the card from the first line of the content", async () => {
    const project = newProject();
    await store("# Rate limits\n\nThe API allows 500 requests a minute.", project);

    const [card] = await cardsFor(project);
    expect(card.title).toBe("Rate limits");
  });

  it("keeps a title the caller gave", async () => {
    const project = newProject();
    await store("Postgres replaced Redis.", project, "medium", "Decision", "Cache moved to Postgres");

    const [card] = await cardsFor(project);
    expect(card.title).toBe("Cache moved to Postgres");
  });

  it("maps each importance level onto the stored scale", async () => {
    const levels: [ImportanceLevel, number][] = [
      ["critical", 0.95],
      ["high", 0.75],
      ["medium", 0.5],
      ["low", 0.25]
    ];

    for (const [level, score] of levels) {
      const project = newProject();
      await store(`Stored at ${level} importance.`, project, level);

      const [card] = await cardsFor(project);
      expect(card.importance).toBe(score);
    }
  });

  it("accepts a raw importance number and clamps it", async () => {
    const created = jest.spyOn(memoryStore, "createMemory");

    await store("Stored above the top of the scale.", newProject(), 4);
    await store("Stored below the bottom of the scale.", newProject(), -2);
    await store("Stored at a score of its own.", newProject(), 0.42);

    // Read at the boundary — the column applies a floor of its own below 0.1.
    expect(created.mock.calls.map(call => call[0].importance)).toEqual([1, 0, 0.42]);

    created.mockRestore();
  });

  it("still stores the transcript when the card cannot be recorded", async () => {
    // What Docker mode does: memories are a SQLite-only feature there.
    const created = jest.spyOn(memoryStore, "createMemory")
      .mockRejectedValue(new Error("Memory features require SQLite storage mode"));

    const project = newProject();
    const result = await store("Memory cards need SQLite storage.", project);
    created.mockRestore();

    expect(result).toContain("Successfully stored memory");
    expect(result).toContain("chunks indexed");
    // Nothing is claimed that was not written.
    expect(result).not.toContain("Memory Card Created");

    const session = await sessionStore.getSessionByName(project);
    const chat = await sessionStore.getFullChat(session!._id);
    expect(chat?.rawText).toBe("Memory cards need SQLite storage.");
    expect(await memoryStore.getMemories(session!._id)).toEqual([]);
  });
});
