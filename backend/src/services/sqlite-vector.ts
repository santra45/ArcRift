import { getSqlite } from "./sqlite";
import { IVectorStore, RetrievedChunk } from "./storage.types";
import { WindowChunk } from "./chunker";
import { generateEmbedding, generateEmbeddings } from "./embeddings";
import { assertIndexMatchesSettings } from "./index-fingerprint";
import { logger } from "../utils/logger";
import { generateHyDEAnswer } from "./hyde";

// sqlite-vec returns raw L2 Euclidean distance (range ~10–30 for 768-dim nomic-embed-text).
// Convert to 0–1 similarity with exponential decay: exp(-distance/20)
// With search_query prefixes, scores move up: distance=8 → 0.67, distance=12 → 0.55
const l2ToScore = (distance: number) => Math.exp(-distance / 20);

/** Split an ID list so a `WHERE id IN (...)` stays under SQLite's bound-parameter limit. */
function inBatches<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const SESSION_THRESHOLD = 0.30;
const SENTENCE_THRESHOLD = 0.30; // Lowered to ensure surgical RAG triggers on rephrased queries
const GLOBAL_THRESHOLD = 0.30;

/**
 * Splits text into sentences while preserving meaningful punctuation.
 */
export function splitIntoSentences(text: string): string[] {
  // Relaxed to 5 chars to catch short code snippets or short facts
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length >= 5);
}

/**
 * Local 'Sentence Trimmer' (Option D)
 * Splits a retrieved chunk into sentences and returns only those that share
 * keywords with the user prompt. 
 */
function getRelevantSentences(content: string, prompt: string, limit = 5): string {
  const sentences = splitIntoSentences(content);
  const pLower = prompt.toLowerCase();
  const promptWords = pLower.split(/\W+/).filter(w => w.length > 3);

  // Detect "History Queries" (e.g., "what did we talk about")
  const isHistoryQuery = /\b(talk|chat|convo|discuss|last|previous|before|history|remember)\b/i.test(pLower);

  const scored = sentences.map(s => {
    const sLower = s.toLowerCase();
    let score = 0;
    for (const word of promptWords) {
      if (sLower.includes(word)) score++;
    }
    return { s, score };
  });

  const filtered = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.s);

  if (filtered.length > 0) return filtered.join(" ");

  // Fallback: Only allow first 3 sentences if it's a history-seeking query.
  // Otherwise, return empty (effectively filters out unrelated noise like slippers vs credit cards).
  return isHistoryQuery ? sentences.slice(0, 3).join(" ") : "";
}

export class SqliteVectorStore implements IVectorStore {
  public db = getSqlite();
  public generateEmbeddings = generateEmbeddings;

  async storeChunks(chunks: WindowChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const sessionId = chunks[0].sessionId;

    // Chunk IDs are positional and their text is stable under append, so adding
    // one turn to a long transcript leaves nearly every chunk byte-identical.
    // Re-embedding the whole session regardless cost ~110s on a 200-chunk
    // project — past the MCP client's request timeout, so the call was
    // abandoned as failed even though the write went on to land. Only chunks
    // whose text actually changed are embedded now.
    const stored = new Map<string, string>();
    for (const row of this.db
      .prepare("SELECT chunk_id, content FROM chunk_metadata WHERE sessionId = ?")
      .all(sessionId) as { chunk_id: string; content: string }[]) {
      stored.set(row.chunk_id, row.content);
    }

    const changed = chunks.filter(c => stored.get(c.id) !== c.content);
    const incoming = new Set(chunks.map(c => c.id));
    const removed = [...stored.keys()].filter(id => !incoming.has(id));

    if (changed.length === 0 && removed.length === 0) {
      logger.info(`Session ${sessionId}: no chunk changed, index left as it is`);
      return;
    }

    // nomic-embed-text: Use 'document' task for indexing.
    //
    // Embedding runs before anything is deleted. This call reaches the
    // embedding backend and can fail; deleting first meant a failure here left
    // the session with no chunks at all, silently unsearchable until the next
    // successful save.
    const chunkEmbeddings = changed.length > 0
      ? await generateEmbeddings(changed.map(c => c.content), "document")
      : [];

    this.purgeChunks(removed);
    // A rewritten chunk can split into fewer sentences than it did before, so
    // its sentence rows are dropped rather than partly overwritten — otherwise
    // the leftovers stay searchable under text the chunk no longer contains.
    this.purgeSentences(changed.map(c => c.id));

    // vec_chunks is a vec0 virtual table and does not honour REPLACE conflict
    // resolution, so a rewritten chunk has to have its old vector deleted
    // first. Nothing noticed while every save wiped the session up front.
    const deleteVec = this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
    const insertVec = this.db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)");
    const insertMeta = this.db.prepare("INSERT OR REPLACE INTO chunk_metadata (chunk_id, sessionId, chunkIndex, content, filePath, fileHash) VALUES (?, ?, ?, ?, ?, ?)");
    const insertFts = this.db.prepare("INSERT OR REPLACE INTO fts_chunks (chunk_id, content) VALUES (?, ?)");

    for (let i = 0; i < changed.length; i++) {
      const chunk = changed[i];
      const embedding = chunkEmbeddings[i];
      const vector = Buffer.from(new Float32Array(embedding).buffer);

      this.db.transaction(() => {
        deleteVec.run(chunk.id);
        insertVec.run(chunk.id, vector);
        insertMeta.run(chunk.id, chunk.sessionId, chunk.chunkIndex, chunk.content, chunk.filePath || null, chunk.fileHash || null);
        insertFts.run(chunk.id, chunk.content);
      })();
    }

    // Offload high-precision sentence indexing to background job, over the
    // changed chunks only — the rest keep the sentence rows they already have.
    //
    // Deliberately not awaited, but a rejection here used to go unhandled and
    // take the whole process down with it — in the MCP server that reads to the
    // client as the connection dropping mid-request.
    if (changed.length > 0) {
      import("./jobs")
        .then(m => m.enqueueJob("sentence_indexing", { chunks: changed }))
        .catch(err => logger.error(`Failed to queue sentence indexing: ${err?.message ?? err}`));
    }

    logger.success(
      `Session ${sessionId}: embedded ${changed.length} chunk(s), reused ${chunks.length - changed.length}, removed ${removed.length}`
    );
  }

  async storeFileChunks(chunks: WindowChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    
    const filePath = chunks[0].filePath;
    const sessionId = chunks[0].sessionId;

    // Embed before deleting, so a failed embedding call cannot leave the file
    // with no chunks indexed.
    const chunkEmbeddings = await generateEmbeddings(chunks.map(c => c.content), "document");

    if (filePath) {
      await this.deleteChunksByFile(filePath, sessionId);
    }

    const insertVec = this.db.prepare("INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)");
    const insertMeta = this.db.prepare("INSERT OR REPLACE INTO chunk_metadata (chunk_id, sessionId, chunkIndex, content, filePath, fileHash) VALUES (?, ?, ?, ?, ?, ?)");
    const insertFts = this.db.prepare("INSERT OR REPLACE INTO fts_chunks (chunk_id, content) VALUES (?, ?)");

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = chunkEmbeddings[i];
      const vector = Buffer.from(new Float32Array(embedding).buffer);

      this.db.transaction(() => {
        insertVec.run(chunk.id, vector);
        insertMeta.run(chunk.id, chunk.sessionId, chunk.chunkIndex, chunk.content, chunk.filePath || null, chunk.fileHash || null);
        insertFts.run(chunk.id, chunk.content);
      })();
    }

    logger.success(`Stored ${chunks.length} chunks for file ${filePath}`);
  }

  async retrieveRelevantChunks(query: string, sessionId: string, topN = 3, keywords: string[] = []): Promise<RetrievedChunk[]> {
    // Stored vectors are only comparable to a query embedded the same way.
    assertIndexMatchesSettings();

    const hydeAnswer = await generateHyDEAnswer(query);
    const augmentedQuery = `${query}\n${hydeAnswer}`;

    const queryEmbedding = await generateEmbedding(augmentedQuery, "query");
    const vector = Buffer.from(new Float32Array(queryEmbedding).buffer);

    // 1. High-Precision Sentence Search (Small-to-Big)
    const sentRows = this.db.prepare(`
      SELECT 
        sm.chunk_id, sm.content, vs.distance
      FROM vec_sentences vs
      JOIN sentence_metadata sm ON vs.sentence_id = sm.sentence_id
      JOIN chunk_metadata m ON sm.chunk_id = m.chunk_id
      WHERE vs.embedding MATCH ? AND m.sessionId = ? AND k = 100
    `).all(vector, sessionId) as any[];

    // 2. Coarse Chunk Search (Context)
    const vecRows = this.db.prepare(`
      SELECT m.chunk_id, m.content, m.chunkIndex, v.distance
      FROM vec_chunks v
      JOIN chunk_metadata m ON v.chunk_id = m.chunk_id
      WHERE v.embedding MATCH ? AND m.sessionId = ? AND k = 20
    `).all(vector, sessionId) as any[];

    // 3. Keyword Search
    // Split into words, remove very short words, and join with OR for better keyword snap
    const ftsWords = query.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3);
    
    if (ftsWords.length === 0) return [];

    // Use FTS5 prefix matching for each word to catch variations (e.g. "encrypt*" matches "encryption")
    const ftsQuery = ftsWords.map(w => `${w}*`).join(" OR ");

    const ftsRows = this.db.prepare(`
      SELECT m.chunk_id, m.chunkIndex, m.content
      FROM fts_chunks f
      JOIN chunk_metadata m ON f.chunk_id = m.chunk_id
      WHERE f.content MATCH ? AND m.sessionId = ?
      LIMIT 20
    `).all(ftsQuery, sessionId) as any[];

    // 4. Group & Filter
    // We group by chunk_id and only keep the sentences that matched.
    const candidates = new Map<string, { chunkIndex: number, sentences: Set<string>, maxScore: number, engines: Set<string> }>();

    sentRows.forEach(r => {
      const score = l2ToScore(r.distance);
      if (score < SENTENCE_THRESHOLD) return;

      if (!candidates.has(r.chunk_id)) {
        candidates.set(r.chunk_id, { chunkIndex: 0, sentences: new Set(), maxScore: score, engines: new Set() });
      }
      candidates.get(r.chunk_id)!.sentences.add(r.content);
      candidates.get(r.chunk_id)!.maxScore = Math.max(candidates.get(r.chunk_id)!.maxScore, score);
      candidates.get(r.chunk_id)!.engines.add("Sentence Vector");
    });

    // Backfill chunk metadata for sentence candidates
    vecRows.forEach(r => {
      if (candidates.has(r.chunk_id)) {
        candidates.get(r.chunk_id)!.chunkIndex = r.chunkIndex;
        candidates.get(r.chunk_id)!.maxScore = Math.max(candidates.get(r.chunk_id)!.maxScore, l2ToScore(r.distance));
        candidates.get(r.chunk_id)!.engines.add("Chunk Vector");
      } else {
        const score = l2ToScore(r.distance);
        if (score >= SESSION_THRESHOLD) {
          candidates.set(r.chunk_id, { chunkIndex: r.chunkIndex, sentences: new Set(), maxScore: score, engines: new Set(["Chunk Vector"]) });
        }
      }
    });

    ftsRows.forEach(r => {
      if (!candidates.has(r.chunk_id)) {
        candidates.set(r.chunk_id, { chunkIndex: r.chunkIndex, sentences: new Set(), maxScore: SESSION_THRESHOLD, engines: new Set(["FTS Keyword"]) });
      } else {
        candidates.get(r.chunk_id)!.engines.add("FTS Keyword");
      }
    });

    return Array.from(candidates.values())
      .map(c => {
        // Fallback: If no high-precision sentences matched but chunk score is high, 
        // inject the first few sentences of the chunk to avoid "zero context".
        let finalContent = "";
        if (c.sentences.size > 0) {
          finalContent = Array.from(c.sentences).join(" ");
        } else if (c.maxScore >= SESSION_THRESHOLD) {
          // Find the chunk content to use as fallback
          const chunkId = Array.from(candidates.keys()).find(id => candidates.get(id) === c);
          const row = this.db.prepare("SELECT content FROM chunk_metadata WHERE chunk_id = ?").get(chunkId) as { content: string } | undefined;
          const rawContent = row?.content || "";
          const allSentences = splitIntoSentences(rawContent);
          finalContent = allSentences.slice(0, 3).join(" ");
        }

        return {
          content: finalContent,
          chunkIndex: c.chunkIndex,
          score: c.maxScore,
          engines: Array.from(c.engines)
        };
      })
      .filter(r => r.score >= SESSION_THRESHOLD && r.content.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  async hybridSearch(query: string, sessionId: string, topN = 3): Promise<RetrievedChunk[]> {
    assertIndexMatchesSettings();
    return this.retrieveRelevantChunks(query, sessionId, topN);
  }

  async retrieveGlobalChunks(query: string, topN = 3, keywords: string[] = []): Promise<RetrievedChunk[]> {
    assertIndexMatchesSettings();

    const words = query.trim().split(/\s+/).filter(w => w.length > 0);
    const isSingleWord = words.length <= 1;
    const candidates = new Map<string, { chunkIndex: number, sentences: Set<string>, maxScore: number, sessionId: string }>();

    try {
      let augmentedQuery = query;
      if (!isSingleWord) {
        try {
          const hydeAnswer = await generateHyDEAnswer(query);
          augmentedQuery = `${query}\n${hydeAnswer}`;
        } catch (e) {
          logger.warn(`HyDE failed for global search: ${e}`);
        }
      }

      const queryEmbedding = await generateEmbedding(augmentedQuery, "query");
      const vector = Buffer.from(new Float32Array(queryEmbedding).buffer);

      // Joined through chunk_metadata so each hit carries the project it came
      // from — a global search is not useful without that attribution.
      const sentRows = this.db.prepare(`
        SELECT sm.chunk_id, sm.content, vs.distance, m.sessionId
        FROM vec_sentences vs
        JOIN sentence_metadata sm ON vs.sentence_id = sm.sentence_id
        JOIN chunk_metadata m ON sm.chunk_id = m.chunk_id
        WHERE vs.embedding MATCH ? AND k = 100
      `).all(vector) as any[];

      sentRows.forEach(r => {
        const score = l2ToScore(r.distance);
        if (score < SENTENCE_THRESHOLD) return;
        if (!candidates.has(r.chunk_id)) {
          candidates.set(r.chunk_id, { chunkIndex: 0, sentences: new Set(), maxScore: score, sessionId: r.sessionId });
        }
        candidates.get(r.chunk_id)!.sentences.add(r.content);
      });
    } catch (e) {
      logger.error(`Embedding generation failed for global search, falling back to FTS: ${e}`);
    }

    const ftsWords = query.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length >= 3);
    if (ftsWords.length > 0) {
      const ftsQuery = ftsWords.map(w => `${w}*`).join(" OR ");
      const ftsRows = this.db.prepare(`
        SELECT m.chunk_id, m.chunkIndex, m.content, m.sessionId
        FROM fts_chunks f
        JOIN chunk_metadata m ON f.chunk_id = m.chunk_id
        WHERE f.content MATCH ?
        LIMIT 20
      `).all(ftsQuery) as any[];

      ftsRows.forEach(r => {
        if (!candidates.has(r.chunk_id)) {
           candidates.set(r.chunk_id, { chunkIndex: r.chunkIndex, sentences: new Set([r.content.substring(0, 300) + "..."]), maxScore: GLOBAL_THRESHOLD, sessionId: r.sessionId });
        }
      });
    }

    return Array.from(candidates.values())
      .map(c => ({
        content: Array.from(c.sentences).join(" "),
        chunkIndex: c.chunkIndex,
        score: c.maxScore,
        sessionId: c.sessionId
      }))
      .filter(r => r.content.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  /**
   * Delete chunks by ID, along with their vectors, keyword rows and sentences.
   * Used for chunks a re-save dropped, so the rest of the index survives.
   */
  private purgeChunks(ids: string[]): void {
    if (ids.length === 0) return;

    this.purgeSentences(ids);
    for (const batch of inBatches(ids)) {
      const ph = batch.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id IN (${ph})`).run(...batch);
        this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id IN (${ph})`).run(...batch);
        this.db.prepare(`DELETE FROM fts_chunks WHERE chunk_id IN (${ph})`).run(...batch);
      })();
    }
  }

  /** Drop the sentence rows derived from the given chunks. */
  private purgeSentences(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;

    const sentenceIds: string[] = [];
    for (const batch of inBatches(chunkIds)) {
      const ph = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT sentence_id FROM sentence_metadata WHERE chunk_id IN (${ph})`)
        .all(...batch) as { sentence_id: string }[];
      sentenceIds.push(...rows.map(r => r.sentence_id));
    }

    for (const batch of inBatches(sentenceIds)) {
      const ph = batch.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM vec_sentences WHERE sentence_id IN (${ph})`).run(...batch);
        this.db.prepare(`DELETE FROM sentence_metadata WHERE sentence_id IN (${ph})`).run(...batch);
      })();
    }
  }

  async deleteChunksBySession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM chunk_metadata WHERE sessionId = ?").run(sessionId);
    this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id NOT IN (SELECT chunk_id FROM chunk_metadata)`).run();
    this.db.prepare(`DELETE FROM fts_chunks WHERE chunk_id NOT IN (SELECT chunk_id FROM chunk_metadata)`).run();
    this.db.prepare(`DELETE FROM vec_sentences WHERE sentence_id NOT IN (SELECT sentence_id FROM sentence_metadata)`).run();
    this.db.prepare(`DELETE FROM sentence_metadata WHERE chunk_id NOT IN (SELECT chunk_id FROM chunk_metadata)`).run();
  }

  async deleteChunksByFile(filePath: string, sessionId: string): Promise<number> {
    const rows = this.db.prepare(`
      SELECT chunk_id FROM chunk_metadata 
      WHERE sessionId = ? AND filePath = ?
    `).all(sessionId, filePath) as { chunk_id: string }[];
    
    const deletedIds = rows.map(r => r.chunk_id);
    if (deletedIds.length === 0) return 0;

    const placeholders = deletedIds.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM fts_chunks WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM sentence_metadata WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM vec_sentences WHERE sentence_id NOT IN (SELECT sentence_id FROM sentence_metadata)`).run();
    })();

    return deletedIds.length;
  }

  async deleteChunksByQuery(query: string, sessionId: string): Promise<number> {
    const rows = this.db.prepare(`
      SELECT chunk_id FROM chunk_metadata 
      WHERE sessionId = ? AND content LIKE ?
    `).all(sessionId, `%${query}%`) as { chunk_id: string }[];
    
    const deletedIds = rows.map(r => r.chunk_id);
    if (deletedIds.length === 0) return 0;

    // 3. Delete them from all tables
    const placeholders = deletedIds.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chunk_metadata WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM fts_chunks WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      this.db.prepare(`DELETE FROM sentence_metadata WHERE chunk_id IN (${placeholders})`).run(...deletedIds);
      // Clean up orphaned sentences
      this.db.prepare(`DELETE FROM vec_sentences WHERE sentence_id NOT IN (SELECT sentence_id FROM sentence_metadata)`).run();
    })();

    return deletedIds.length;
  }

  async mergeSession(sourceId: string, targetId: string): Promise<void> {
    this.db.prepare("UPDATE chunk_metadata SET sessionId = ? WHERE sessionId = ?").run(targetId, sourceId);
    logger.info(`Merged vector chunks from session ${sourceId} to ${targetId}`);
  }
}
