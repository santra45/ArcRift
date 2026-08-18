import { getSqlite } from "./sqlite";
import { getEmbeddingConfig } from "../utils/settings";
import { logger } from "../utils/logger";

export interface IndexFingerprint {
  provider: string;
  model: string;
  dimension: number;
}

/** The index holds vectors from a different embedding backend than the settings name. */
export class IndexFingerprintMismatchError extends Error {}

const describeFingerprint = (f: IndexFingerprint) => `${f.provider}/${f.model} (${f.dimension}d)`;

/** What the live settings would stamp on an index built right now. */
export function currentFingerprint(): IndexFingerprint {
  const { provider, model, dimension } = getEmbeddingConfig();
  return { provider, model, dimension };
}

export function readIndexFingerprint(): IndexFingerprint | null {
  const row = getSqlite()
    .prepare("SELECT provider, model, dimension FROM index_meta WHERE id = 'singleton'")
    .get() as IndexFingerprint | undefined;
  return row || null;
}

export function writeIndexFingerprint(fingerprint: IndexFingerprint = currentFingerprint()): IndexFingerprint {
  getSqlite()
    .prepare(
      "INSERT OR REPLACE INTO index_meta (id, provider, model, dimension, updatedAt) " +
      "VALUES ('singleton', ?, ?, ?, ?)"
    )
    .run(fingerprint.provider, fingerprint.model, fingerprint.dimension, new Date().toISOString());
  return fingerprint;
}

/**
 * Refuse to search an index that was embedded with something else.
 *
 * A model change does not fail loudly on its own: the vectors stay the right
 * width, the distances stay in range, and search keeps handing back
 * confident-looking scores over what is now noise. The stored fingerprint is
 * the only thing that can tell the difference.
 */
export function assertIndexMatchesSettings(): void {
  const current = currentFingerprint();
  const stored = readIndexFingerprint();

  if (!stored) {
    // Nothing recorded yet. An empty index has nothing to disagree with, so the
    // stamp waits until there are vectors to describe — which is also how an
    // index built before this table existed adopts what it has been running on.
    const populated = getSqlite().prepare("SELECT 1 FROM chunk_metadata LIMIT 1").get();
    if (populated) {
      writeIndexFingerprint(current);
      logger.info(`Embedding index fingerprinted as ${describeFingerprint(current)}`);
    }
    return;
  }

  const matches =
    stored.provider === current.provider &&
    stored.model === current.model &&
    stored.dimension === current.dimension;
  if (matches) return;

  throw new IndexFingerprintMismatchError(
    `Embedding configuration changed from ${describeFingerprint(stored)} to ` +
    `${describeFingerprint(current)} — re-index required. ` +
    "POST /api/rag/reindex to rebuild the vectors with the current model."
  );
}
