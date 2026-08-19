import axios from "axios";
import fs from "fs";
import { EmbeddingConfig } from "../../utils/settings";

// Deliberately not a filename another suite uses — the suites run in separate
// workers and would otherwise fight over the same database.
const TEST_DB = "test-embeddings.db";
const DB_FILES = [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`];

// The provider layer is exercised against an injected configuration, so nothing
// here depends on the settings file the developer happens to have.
let mockConfig: EmbeddingConfig;

jest.mock("../../utils/settings", () => ({
  getSettings: () => ({}),
  getEmbeddingConfig: () => mockConfig,
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

const mockedAxios = axios as unknown as { post: jest.Mock; get: jest.Mock };

import { generateEmbedding, generateEmbeddings } from "../embeddings";
import {
  assertIndexMatchesSettings,
  readIndexFingerprint,
  writeIndexFingerprint,
} from "../index-fingerprint";
import { reindexEmbeddings } from "../reindex";
import { initSqlite, getSqlite } from "../sqlite";

const vector = (fill = 0.1, length = 768) => new Array(length).fill(fill);

const OLLAMA_CONFIG: EmbeddingConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "nomic-embed-text",
  dimension: 768,
};

const OPENAI_CONFIG: EmbeddingConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-key",
  model: "text-embedding-3-small",
  dimension: 768,
};

const GEMINI_CONFIG: EmbeddingConfig = {
  provider: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: "gemini-test-key",
  model: "text-embedding-004",
  dimension: 768,
};

const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];

/** The suite asserts on error text, which rejects.toThrow() does not compare. */
async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  return "";
}

beforeEach(() => {
  mockConfig = { ...OLLAMA_CONFIG };
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
  for (const name of PROXY_VARS) delete process.env[name];
});

describe("embedding providers", () => {
  describe("ollama", () => {
    it("posts to /api/embeddings with the document prefix", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { embedding: vector() } });

      const result = await generateEmbedding("chunk text", "document");

      expect(result).toHaveLength(768);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://localhost:11434/api/embeddings",
        { model: "nomic-embed-text", prompt: "search_document: chunk text" },
        { timeout: 60000 }
      );
    });

    it("uses the query prefix for queries", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { embedding: vector() } });

      await generateEmbedding("what did we decide", "query");

      expect(mockedAxios.post.mock.calls[0][1].prompt).toBe("search_query: what did we decide");
    });

    it("leaves models other than nomic-embed-text unprefixed", async () => {
      mockConfig.model = "mxbai-embed-large";
      mockedAxios.post.mockResolvedValueOnce({ data: { embedding: vector() } });

      await generateEmbedding("chunk text", "document");

      expect(mockedAxios.post.mock.calls[0][1].prompt).toBe("chunk text");
    });

    it("falls back to /api/embed when /api/embeddings fails", async () => {
      mockedAxios.post
        .mockRejectedValueOnce(new Error("404 page not found"))
        .mockResolvedValueOnce({ data: { embeddings: [vector(0.4)] } });

      const result = await generateEmbedding("chunk text", "query");

      expect(result[0]).toBe(0.4);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockedAxios.post.mock.calls[1][0]).toBe("http://localhost:11434/api/embed");
      expect(mockedAxios.post.mock.calls[1][1]).toEqual({
        model: "nomic-embed-text",
        input: "search_query: chunk text",
      });
    });

    it("keeps batches of three with a rest between them", async () => {
      mockedAxios.post.mockResolvedValue({ data: { embedding: vector() } });

      const results = await generateEmbeddings(["a", "b", "c", "d"], "document");

      expect(results).toHaveLength(4);
      expect(mockedAxios.post).toHaveBeenCalledTimes(4);
    });
  });

  describe("openai-compatible", () => {
    beforeEach(() => {
      mockConfig = { ...OPENAI_CONFIG };
    });

    it("posts the whole batch to /embeddings with bearer auth", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { data: [{ index: 0, embedding: vector() }, { index: 1, embedding: vector(0.2) }] },
      });

      await generateEmbeddings(["first", "second"], "document");

      const [url, payload, config] = mockedAxios.post.mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/embeddings");
      // No search_document prefix — that is an Ollama/nomic convention only.
      expect(payload).toEqual({
        model: "text-embedding-3-small",
        input: ["first", "second"],
        dimensions: 768,
      });
      expect(config.headers.Authorization).toBe("Bearer sk-test-key");
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it("sends more texts per request than Ollama would", async () => {
      const texts = ["a", "b", "c", "d", "e"];
      mockedAxios.post.mockResolvedValueOnce({
        data: { data: texts.map((_, index) => ({ index, embedding: vector() })) },
      });

      await generateEmbeddings(texts, "document");

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it("reorders the response by data[].index", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          data: [
            { index: 2, embedding: vector(0.3) },
            { index: 0, embedding: vector(0.1) },
            { index: 1, embedding: vector(0.2) },
          ],
        },
      });

      const results = await generateEmbeddings(["first", "second", "third"], "document");

      expect(results.map(v => v[0])).toEqual([0.1, 0.2, 0.3]);
    });

    it("omits the dimensions parameter for models that do not take one", async () => {
      mockConfig.model = "BAAI/bge-base-en-v1.5";
      mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: vector() }] } });

      await generateEmbedding("query text", "query");

      expect(mockedAxios.post.mock.calls[0][1].dimensions).toBeUndefined();
    });
  });

  describe("gemini", () => {
    beforeEach(() => {
      mockConfig = { ...GEMINI_CONFIG };
    });

    it("uses :embedContent for a single text", async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { embedding: { values: vector() } } });

      const result = await generateEmbedding("one text", "query");

      const [url, payload, config] = mockedAxios.post.mock.calls[0];
      expect(result).toHaveLength(768);
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
      );
      expect(payload).toEqual({
        content: { parts: [{ text: "one text" }] },
        outputDimensionality: 768,
      });
      expect(config.headers["x-goog-api-key"]).toBe("gemini-test-key");
    });

    it("uses :batchEmbedContents for several texts", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { embeddings: [{ values: vector(0.1) }, { values: vector(0.2) }] },
      });

      const results = await generateEmbeddings(["first", "second"], "document");

      const [url, payload] = mockedAxios.post.mock.calls[0];
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents"
      );
      expect(payload.requests).toEqual([
        {
          model: "models/text-embedding-004",
          content: { parts: [{ text: "first" }] },
          outputDimensionality: 768,
        },
        {
          model: "models/text-embedding-004",
          content: { parts: [{ text: "second" }] },
          outputDimensionality: 768,
        },
      ]);
      expect(results.map(v => v[0])).toEqual([0.1, 0.2]);
    });
  });

  describe("dimension handling", () => {
    it("refuses a vector the index cannot hold instead of reshaping it", async () => {
      mockConfig = { ...OPENAI_CONFIG, model: "text-embedding-3-large" };
      mockedAxios.post.mockResolvedValueOnce({
        data: { data: [{ index: 0, embedding: vector(0.1, 3072) }] },
      });

      const message = await messageOf(() => generateEmbedding("query text", "query"));

      expect(message).toContain("openai-compatible");
      expect(message).toContain("text-embedding-3-large");
      expect(message).toContain("3072");
      expect(message).toContain("768");
    });

    it("does not retry a dimension mismatch", async () => {
      mockedAxios.post.mockResolvedValue({ data: { embedding: vector(0.1, 1024) } });

      await messageOf(() => generateEmbedding("chunk text", "document"));

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("proxy", () => {
    it("configures no proxy when the environment sets none", async () => {
      mockConfig = { ...OPENAI_CONFIG };
      mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: vector() }] } });

      await generateEmbedding("query text", "query");

      const config = mockedAxios.post.mock.calls[0][2];
      expect(config.proxy).toBeUndefined();
      expect("proxy" in config).toBe(false);
    });

    it("uses the proxy the environment names", async () => {
      process.env.HTTPS_PROXY = "http://proxy.internal:8080";
      mockConfig = { ...OPENAI_CONFIG };
      mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ index: 0, embedding: vector() }] } });

      await generateEmbedding("query text", "query");

      expect(mockedAxios.post.mock.calls[0][2].proxy).toEqual({
        host: "proxy.internal",
        port: 8080,
        protocol: "http",
      });
    });
  });
});

/** A refusal shaped the way Gemini shapes one, details and all. */
function rateLimited(options: { quotaId?: string; retryDelay?: string } = {}) {
  const err: any = new Error("Request failed with status code 429");
  err.response = {
    status: 429,
    headers: {},
    data: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: options.quotaId ?? "EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier" },
            ],
          },
          ...(options.retryDelay
            ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: options.retryDelay }]
            : []),
        ],
      },
    },
  };
  return err;
}

describe("rate limits", () => {
  beforeEach(() => {
    mockConfig = { ...GEMINI_CONFIG };
    // These tests are about refusals and truncation, not pacing, so the limiter
    // is lifted out of the way. The pacing tests set their own.
    process.env.EMBEDDING_RPM = "100000";
    process.env.EMBEDDING_TPM = "100000000";
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.EMBEDDING_RPM;
    delete process.env.EMBEDDING_TPM;
  });

  it("waits as long as the provider asked before retrying", async () => {
    jest.useFakeTimers();
    mockedAxios.post
      .mockRejectedValueOnce(rateLimited({ retryDelay: "24s" }))
      .mockResolvedValueOnce({ data: { embedding: { values: vector() } } });

    const pending = generateEmbedding("one text", "query");

    await jest.advanceTimersByTimeAsync(23_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toHaveLength(768);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it("does not retry a daily quota, which no wait will restore", async () => {
    mockedAxios.post.mockRejectedValue(
      rateLimited({ quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier" })
    );

    const message = await messageOf(() => generateEmbedding("one text", "query"));

    expect(message).toContain("daily quota exhausted");
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it("names the exhausted quota rather than only the status code", async () => {
    jest.useFakeTimers();
    mockedAxios.post.mockRejectedValue(rateLimited({ retryDelay: "1s" }));

    const pending = messageOf(() => generateEmbedding("one text", "query"));
    await jest.advanceTimersByTimeAsync(10_000);

    expect(await pending).toContain("EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier");
  });

  it("holds a batch back rather than spending a minute it does not have", async () => {
    jest.useFakeTimers();
    process.env.EMBEDDING_RPM = "25";
    process.env.EMBEDDING_TPM = "100000000";

    // A fresh module means a fresh window; the pacer's is deliberately shared
    // process-wide so a query mid-re-index counts against the same allowance.
    let paced: typeof import("../embeddings");
    jest.isolateModules(() => {
      paced = require("../embeddings");
    });

    mockedAxios.post.mockResolvedValue({
      data: { embeddings: new Array(25).fill({ values: vector() }) },
    });

    // 30 texts is two Gemini batches, and Gemini bills every text in one, so the
    // second cannot go out until the first batch ages out of the window.
    const pending = paced!.generateEmbeddings(new Array(30).fill("text"), "document");

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});

describe("index fingerprint", () => {
  let db: any;

  const seedChunk = (id: string, content: string) => {
    db.prepare(
      "INSERT INTO chunk_metadata (chunk_id, sessionId, chunkIndex, content) VALUES (?, 'fp-session', 0, ?)"
    ).run(id, content);
    db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)").run(
      id,
      Buffer.from(new Float32Array(vector(0.1)).buffer)
    );
  };

  beforeAll(() => {
    process.env.SQLITE_DB_PATH = TEST_DB;
    // Start from an empty file — a database left behind by the previous run
    // still carries its fingerprint row and its chunks.
    for (const f of DB_FILES) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    initSqlite();
    db = getSqlite();
    db.prepare(
      "INSERT INTO sessions (id, projectName, platform, createdAt, updatedAt) " +
      "VALUES ('fp-session', 'Fingerprint Project', 'chrome', ?, ?)"
    ).run(new Date().toISOString(), new Date().toISOString());
  });

  it("stamps nothing while the index is empty", () => {
    assertIndexMatchesSettings();
    expect(readIndexFingerprint()).toBeNull();
  });

  it("stamps the active configuration once the index has content", () => {
    seedChunk("fp-chunk-0", "the deployment runs on a single box");

    assertIndexMatchesSettings();

    expect(readIndexFingerprint()).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimension: 768,
    });
  });

  it("accepts a matching configuration", () => {
    expect(() => assertIndexMatchesSettings()).not.toThrow();
  });

  it("refuses a configuration the index was not built with", () => {
    mockConfig = { ...GEMINI_CONFIG };

    let message = "";
    try {
      assertIndexMatchesSettings();
    } catch (err: any) {
      message = String(err?.message ?? err);
    }

    expect(message).toContain("ollama/nomic-embed-text (768d)");
    expect(message).toContain("gemini/text-embedding-004 (768d)");
    expect(message).toContain("re-index required");
  });

  it("refuses a model change within the same provider", () => {
    mockConfig = { ...OLLAMA_CONFIG, model: "mxbai-embed-large" };

    let message = "";
    try {
      assertIndexMatchesSettings();
    } catch (err: any) {
      message = String(err?.message ?? err);
    }

    expect(message).toContain("mxbai-embed-large");
  });

  it("keeps a single fingerprint row", () => {
    writeIndexFingerprint({ provider: "gemini", model: "text-embedding-004", dimension: 768 });
    writeIndexFingerprint({ provider: "ollama", model: "nomic-embed-text", dimension: 768 });

    const { count } = db.prepare("SELECT COUNT(*) AS count FROM index_meta").get();
    expect(count).toBe(1);
    expect(readIndexFingerprint()?.provider).toBe("ollama");
  });

  describe("re-index", () => {
    beforeAll(() => {
      seedChunk("fp-chunk-1", "the retry budget is three attempts");
      db.prepare(
        "INSERT INTO sentence_metadata (sentence_id, chunk_id, content) VALUES (?, 'fp-chunk-0', ?)"
      ).run("fp-chunk-0_s0", "the deployment runs on a single box");
      db.prepare("INSERT INTO vec_sentences (sentence_id, embedding) VALUES (?, ?)").run(
        "fp-chunk-0_s0",
        Buffer.from(new Float32Array(vector(0.1)).buffer)
      );
    });

    it("re-embeds the stored content and adopts the new fingerprint", async () => {
      mockConfig = { ...GEMINI_CONFIG };
      mockedAxios.post.mockImplementation(async (url: string, payload: any) => {
        if (String(url).endsWith(":batchEmbedContents")) {
          return { data: { embeddings: payload.requests.map(() => ({ values: vector(0.9) })) } };
        }
        return { data: { embedding: { values: vector(0.9) } } };
      });

      const result = await reindexEmbeddings();

      expect(result).toEqual({
        provider: "gemini",
        model: "text-embedding-004",
        dimension: 768,
        chunks: 2,
        sentences: 1,
      });
      // The chunk text came from chunk_metadata, not from a re-scrape.
      const batched = mockedAxios.post.mock.calls.find(([url]) =>
        String(url).endsWith(":batchEmbedContents")
      );
      expect(batched[1].requests.map((r: any) => r.content.parts[0].text)).toEqual([
        "the deployment runs on a single box",
        "the retry budget is three attempts",
      ]);

      // vec0 rejects a second row under the same key, so the counts holding
      // steady is what proves the old vectors were deleted first.
      expect(db.prepare("SELECT COUNT(*) AS count FROM vec_chunks").get().count).toBe(2);
      expect(db.prepare("SELECT COUNT(*) AS count FROM vec_sentences").get().count).toBe(1);
      expect(readIndexFingerprint()).toEqual({
        provider: "gemini",
        model: "text-embedding-004",
        dimension: 768,
      });
    });

    it("leaves retrieval happy with the rebuilt index", () => {
      mockConfig = { ...GEMINI_CONFIG };
      expect(() => assertIndexMatchesSettings()).not.toThrow();
    });
  });
});
