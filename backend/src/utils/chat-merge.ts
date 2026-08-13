/**
 * Merging newly captured chat text into what is already stored.
 *
 * Saves are not always a superset of what came before. The extension skips
 * messages it has already sent, so a second save carries only the new turns,
 * and a save taken after scrolling up carries older ones. Replacing rawText
 * with whatever arrived last therefore discards conversation instead of
 * extending it.
 *
 * Turns are matched on their exact text, so a re-send of an unchanged
 * transcript is a no-op.
 */

/**
 * Split a transcript into turns.
 *
 * Extension transcripts look like `[User]: ...` / `[Assistant]: ...` separated
 * by a blank line, but a single message can itself contain blank lines (code
 * blocks, paragraphs), so the split only fires on a blank line that is followed
 * by a turn marker. Text without markers — anything stored through the MCP
 * store_memory tool — stays in one block.
 */
export function splitTurns(text: string): string[] {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n{2,}(?=\[(?:User|Assistant)\]:)/)
    .map(t => t.trim())
    .filter(Boolean);
}

const sameSequence = (a: string[], b: string[]) =>
  a.length === b.length && a.every((turn, i) => turn === b[i]);

/** Index at which `run` appears contiguously inside `turns`, or -1. */
function indexOfRun(turns: string[], run: string[]): number {
  if (run.length === 0) return 0;
  if (run.length > turns.length) return -1;
  for (let i = 0; i <= turns.length - run.length; i++) {
    if (sameSequence(turns.slice(i, i + run.length), run)) return i;
  }
  return -1;
}

/**
 * Merge `incoming` into `existing`, returning the full merged transcript and
 * just the turns that were newly added (useful for skipping work when a save
 * carries nothing new).
 */
export function mergeChatText(
  existing: string,
  incoming: string
): { merged: string; added: string } {
  const previous = splitTurns(existing);
  const next = splitTurns(incoming);

  if (next.length === 0) return { merged: previous.join("\n\n"), added: "" };
  if (previous.length === 0) return { merged: next.join("\n\n"), added: next.join("\n\n") };

  const seen = new Set(previous);
  if (next.every(turn => seen.has(turn))) {
    // Whole capture is already stored — a re-send after a page reload.
    return { merged: previous.join("\n\n"), added: "" };
  }

  // The capture contains the whole stored run — what a full-thread save looks
  // like once the scraper walks the entire conversation. It supersedes.
  if (indexOfRun(next, previous) !== -1) {
    const fresh = next.filter(turn => !seen.has(turn));
    return { merged: next.join("\n\n"), added: fresh.join("\n\n") };
  }

  const maxOverlap = Math.min(previous.length, next.length);

  // The capture continues the stored transcript: its opening turns repeat the
  // stored tail. Keep everything past the overlap.
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (sameSequence(previous.slice(previous.length - overlap), next.slice(0, overlap))) {
      const tail = next.slice(overlap);
      return { merged: [...previous, ...tail].join("\n\n"), added: tail.join("\n\n") };
    }
  }

  // The capture precedes the stored transcript: its closing turns repeat the
  // stored head. This is what a scrolled-up save looks like.
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (sameSequence(next.slice(next.length - overlap), previous.slice(0, overlap))) {
      const head = next.slice(0, next.length - overlap);
      return { merged: [...head, ...previous].join("\n\n"), added: head.join("\n\n") };
    }
  }

  // No contiguous overlap. Order between the two runs is unknowable, so append
  // the unseen turns — incomplete ordering beats dropping them.
  const fresh = next.filter(turn => !seen.has(turn));
  return { merged: [...previous, ...fresh].join("\n\n"), added: fresh.join("\n\n") };
}
