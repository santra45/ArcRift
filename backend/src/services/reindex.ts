// Rebuilds every stored vector with the embedding backend currently configured.
// Needed after a deliberate provider or model change, which leaves the existing
// vectors unreadable to the new model even though they are still the right width.

import { getSqlite } from "./sqlite";
import { generateEmbeddings } from "./embeddings";
import { currentFingerprint, writeIndexFingerprint, IndexFingerprint } from "./index-fingerprint";
import { getEmbeddingConfig } from "../utils/settings";
import { logger } from "../utils/logger";

export interface ReindexResult extends IndexFingerprint {
  chunks: number;
  sentences: number;
}

// Bounds how much text and how many vectors are held at once — an index of a
// few thousand chunks would otherwise be materialised in full before the first
// row is written.
const REINDEX_SLICE = 200;

function slices<T>(items: T[], size = REINDEX_SLICE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Re-embed the whole index from the text kept alongside it.
 *
 * chunk_metadata and sentence_metadata carry every chunk's and sentence's
 * content, so nothing is lost by throwing the vectors away and deriving them
 * again. The fingerprint is written only once the last row lands: a run that
 * fails part way leaves the old fingerprint in place, so retrieval keeps
 * refusing until the rebuild is actually finished.
 */
export async function reindexEmbeddings(): Promise<ReindexResult> {
  const db = getSqlite();
  const config = getEmbeddingConfig();

  const chunkRows = db
    .prepare("SELECT chunk_id, content FROM chunk_metadata ORDER BY chunk_id")
    .all() as { chunk_id: string; content: string }[];
  const sentenceRows = db
    .prepare("SELECT sentence_id, content FROM sentence_metadata ORDER BY sentence_id")
    .all() as { sentence_id: string; content: string }[];

  logger.info(
    `Re-indexing ${chunkRows.length} chunk(s) and ${sentenceRows.length} sentence(s) ` +
    `with ${config.provider}/${config.model}`
  );

  await rewrite(chunkRows.map(r => ({ id: r.chunk_id, content: r.content })), "vec_chunks", "chunk_id");
  await rewrite(sentenceRows.map(r => ({ id: r.sentence_id, content: r.content })), "vec_sentences", "sentence_id");

  const fingerprint = writeIndexFingerprint(currentFingerprint());
  logger.success(
    `Re-index complete: ${chunkRows.length} chunk(s), ${sentenceRows.length} sentence(s) ` +
    `now embedded with ${fingerprint.provider}/${fingerprint.model}`
  );

  return { ...fingerprint, chunks: chunkRows.length, sentences: sentenceRows.length };
}

async function rewrite(
  rows: { id: string; content: string }[],
  table: "vec_chunks" | "vec_sentences",
  idColumn: "chunk_id" | "sentence_id"
): Promise<void> {
  if (rows.length === 0) return;

  // vec0 virtual tables do not honour REPLACE conflict resolution, so the old
  // vector has to be deleted before the new one can take its place.
  const deleteVec = getSqlite().prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`);
  const insertVec = getSqlite().prepare(`INSERT INTO ${table} (${idColumn}, embedding) VALUES (?, ?)`);

  const persist = (batch: { id: string; content: string }[], vectors: number[][]) =>
    getSqlite().transaction(() => {
      for (let i = 0; i < vectors.length; i++) {
        deleteVec.run(batch[i].id);
        insertVec.run(batch[i].id, Buffer.from(new Float32Array(vectors[i]).buffer));
      }
    })();

  let done = 0;
  for (const slice of slices(rows)) {
    // Written as each embedding call lands rather than once the whole slice is
    // in hand. A hosted provider can refuse part way through, and re-earning
    // vectors it already returned costs quota a capped key does not get back.
    await generateEmbeddings(slice.map(r => r.content), "document", (vectors, startIndex) => {
      persist(slice.slice(startIndex, startIndex + vectors.length), vectors);
      done += vectors.length;
      logger.debug(`[ArcRift] Re-indexed ${done}/${rows.length} row(s) of ${table}`);
    });
  }
}
