/**
 * chunker.ts — Sliding Window Chunker (v1.3.3)
 *
 * Fix: Added guard against infinite loop when overlapWords >= windowWords.
 * If step would be <= 0, the function now clamps overlap to windowWords - 1.
 */

export interface WindowChunk {
  id: string;
  sessionId: string;
  content: string;
  chunkIndex: number;
  wordStart: number;
  wordEnd: number;
  filePath?: string;
  fileHash?: string;
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * How full a chunk must be before it stops absorbing further blocks.
 *
 * Below this it is too thin to embed usefully on its own, so short turns get
 * grouped; at or above it the chunk already covers one subject and taking the
 * next block would merge two topics.
 */
const MIN_FILL_RATIO = 0.4;

/**
 * Natural boundaries in stored text.
 *
 * A blank line separates turns in a scraped transcript and paragraphs in notes
 * written through store_memory, so it marks where one topic stops and the next
 * begins. Splitting purely by word count ignored these and produced chunks that
 * stitched the end of one topic onto the start of another.
 */
function splitIntoBlocks(text: string): string[] {
  return text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
}

/** Plain word-window pass, used for text with no internal structure. */
function slideOver(
  words: string[],
  sessionId: string,
  windowWords: number,
  safeOverlap: number,
  wordOffset: number,
  startIndex: number,
): WindowChunk[] {
  const step = windowWords - safeOverlap;
  const chunks: WindowChunk[] = [];
  let i = 0;
  let chunkIndex = startIndex;

  while (i < words.length) {
    const slice = words.slice(i, i + windowWords);
    chunks.push({
      id: `${sessionId}-chunk-${chunkIndex}`,
      sessionId,
      content: slice.join(" "),
      chunkIndex,
      wordStart: wordOffset + i,
      wordEnd: wordOffset + Math.min(i + windowWords - 1, words.length - 1),
    });
    i += step;
    chunkIndex++;
    if (i >= words.length) break;
  }

  return chunks;
}

/**
 * Split text into chunks that respect topic boundaries.
 *
 * Whole blocks are packed together until the window fills, so a chunk starts
 * and ends on a turn or paragraph rather than mid-thought. Text with no blank
 * lines has no boundaries to respect and falls back to the original word
 * window, which keeps the positional guarantees callers rely on.
 *
 * @param text        Full raw chat text (already PII-scrubbed)
 * @param sessionId   Session ID — used to generate deterministic chunk IDs
 * @param windowWords Target words per chunk (default 150 ≈ ~200 tokens)
 * @param overlapWords Words carried between adjacent chunks (default 50)
 */
export function slidingWindowChunks(
  text: string,
  sessionId: string,
  windowWords = 150,
  overlapWords = 50,
): WindowChunk[] {
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) return [];

  // FIX (Issue #5): Guard against infinite loop if overlapWords >= windowWords.
  // Clamp overlap so step is always at least 1.
  const safeOverlap = Math.min(overlapWords, windowWords - 1);

  // If the whole chat fits in one window, return it as a single chunk
  if (words.length <= windowWords) {
    return [{
      id: `${sessionId}-chunk-0`,
      sessionId,
      content: text.trim(),
      chunkIndex: 0,
      wordStart: 0,
      wordEnd: words.length - 1,
    }];
  }

  const blocks = splitIntoBlocks(text);
  if (blocks.length <= 1) {
    return slideOver(words, sessionId, windowWords, safeOverlap, 0, 0);
  }

  const chunks: WindowChunk[] = [];
  let chunkIndex = 0;
  let wordCursor = 0;      // position in the document, in words
  let pending: string[] = [];
  let pendingWords = 0;
  let pendingStart = 0;

  const flush = () => {
    if (pending.length === 0) return;
    chunks.push({
      id: `${sessionId}-chunk-${chunkIndex}`,
      sessionId,
      content: pending.join("\n\n"),
      chunkIndex,
      wordStart: pendingStart,
      wordEnd: pendingStart + pendingWords - 1,
    });
    chunkIndex++;
  };

  for (const block of blocks) {
    const blockWords = countWords(block);

    // A block larger than the window has to be split internally — nothing else
    // can keep it under budget.
    if (blockWords > windowWords) {
      flush();
      pending = [];
      pendingWords = 0;
      const inner = slideOver(
        block.split(/\s+/).filter(Boolean),
        sessionId, windowWords, safeOverlap, wordCursor, chunkIndex,
      );
      chunks.push(...inner);
      chunkIndex += inner.length;
      wordCursor += blockWords;
      pendingStart = wordCursor;
      continue;
    }

    // Close the chunk once it holds enough to stand on its own, so two whole
    // topics do not get packed together just because they both fit. Blocks are
    // only grouped while the chunk is too small to be useful alone — a one-line
    // turn is not worth embedding by itself.
    const alreadySubstantial = pendingWords >= windowWords * MIN_FILL_RATIO;
    const wouldOverflow = pendingWords + blockWords > windowWords;

    if (pending.length > 0 && (wouldOverflow || alreadySubstantial)) {
      flush();
      pending = [];
      pendingWords = 0;
      pendingStart = wordCursor;
    }

    if (pending.length === 0) pendingStart = wordCursor;
    pending.push(block);
    pendingWords += blockWords;
    wordCursor += blockWords;
  }

  flush();
  return chunks;
}
