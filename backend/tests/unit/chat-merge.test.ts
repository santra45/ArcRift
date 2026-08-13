/**
 * chat-merge.test.ts
 *
 * Unit tests for mergeChatText / splitTurns — the logic that decides whether a
 * save extends stored memory or replaces it. Pure functions, no I/O.
 *
 * Key guarantee tested: NOTHING IS EVER LOST. A save may add turns or leave
 * storage untouched, but it must never drop a turn that was already stored.
 */

import { mergeChatText, splitTurns } from "../../src/utils/chat-merge";

const A = "[User]: first question";
const B = "[Assistant]: first answer";
const C = "[User]: second question";
const D = "[Assistant]: second answer";
const t = (...turns: string[]) => turns.join("\n\n");

// ── Turn splitting ─────────────────────────────────────────────────

describe("splitTurns", () => {
  test("returns nothing for empty or whitespace-only text", () => {
    expect(splitTurns("")).toHaveLength(0);
    expect(splitTurns("   \n  \t ")).toHaveLength(0);
  });

  test("splits a transcript on turn markers", () => {
    expect(splitTurns(t(A, B, C))).toHaveLength(3);
  });

  test("blank lines inside a single message do not split it", () => {
    const withCode = "[Assistant]: here you go\n\n```js\nconst x = 1;\n\nconst y = 2;\n```";
    expect(splitTurns(withCode)).toHaveLength(1);
  });

  test("markerless notes split on blank lines", () => {
    // store_memory content has no turn markers. Treating a whole note as one
    // block made merging all-or-nothing.
    expect(splitTurns("para one\n\npara two\n\npara three")).toHaveLength(3);
  });

  test("a markerless note without blank lines stays one block", () => {
    expect(splitTurns("a single line of prose")).toHaveLength(1);
  });
});

// ── Merging transcripts ────────────────────────────────────────────

describe("mergeChatText — transcripts", () => {
  test("a delta save appends instead of replacing", () => {
    const r = mergeChatText(t(A, B), t(C, D));
    expect(r.merged).toBe(t(A, B, C, D));
    expect(r.added).toBe(t(C, D));
  });

  test("an identical re-send changes nothing", () => {
    const r = mergeChatText(t(A, B), t(A, B));
    expect(r.merged).toBe(t(A, B));
    expect(r.added).toBe("");
  });

  test("an overlapping continuation does not duplicate the overlap", () => {
    const r = mergeChatText(t(A, B), t(B, C));
    expect(r.merged).toBe(t(A, B, C));
    expect(r.added).toBe(C);
  });

  test("a capture of older turns is prepended, not appended", () => {
    // What a save taken after scrolling up looks like.
    const r = mergeChatText(t(C, D), t(A, B, C));
    expect(r.merged).toBe(t(A, B, C, D));
    expect(r.added).toBe(t(A, B));
  });

  test("a full-thread capture absorbs the stored run", () => {
    // The stored run sits in the middle of the capture — the shape every save
    // takes once the scraper walks the whole conversation.
    const r = mergeChatText(t(C), t(A, B, C, D));
    expect(r.merged).toBe(t(A, B, C, D));
  });

  test("a disjoint capture keeps both runs", () => {
    const r = mergeChatText(t(A), t(D));
    expect(r.merged).toContain(A);
    expect(r.merged).toContain(D);
  });

  test("the first save stores the capture as-is", () => {
    expect(mergeChatText("", t(A, B)).merged).toBe(t(A, B));
  });

  test("an empty capture leaves storage untouched", () => {
    const r = mergeChatText(t(A, B), "");
    expect(r.merged).toBe(t(A, B));
    expect(r.added).toBe("");
  });
});

// ── Formatting changes on the capture side ─────────────────────────

describe("mergeChatText — formatting", () => {
  // Fixing block-boundary extraction changed the text of every turn. Without
  // whitespace-insensitive matching, the next save would re-append the entire
  // conversation as if it were new.
  const stored = t(A, "[Assistant]: Best Subreddits for New AccountsThese are welcoming.");
  const recaptured = t(A, "[Assistant]: Best Subreddits for New Accounts\nThese are welcoming.");

  test("a re-capture with fixed spacing is not treated as new content", () => {
    expect(mergeChatText(stored, recaptured).added).toBe("");
  });

  test("nothing new means nothing is rewritten", () => {
    expect(mergeChatText(stored, recaptured).merged).toBe(stored);
  });

  test("a save carrying new turns upgrades the stored formatting", () => {
    const r = mergeChatText(stored, t(recaptured, C));
    expect(r.merged).not.toContain("AccountsThese");
    expect(r.merged).toContain(C);
    expect(r.added).toBe(C);
  });
});

// ── Merging store_memory notes ─────────────────────────────────────

describe("mergeChatText — markerless notes", () => {
  test("separate memories accumulate", () => {
    const r = mergeChatText("first memory", "second memory");
    expect(r.merged).toBe("first memory\n\nsecond memory");
    expect(r.added).toBe("second memory");
  });

  test("storing the same memory twice is a no-op", () => {
    expect(mergeChatText("first memory", "first memory").added).toBe("");
  });

  test("re-storing part of an existing note adds nothing", () => {
    const note = "para one\n\npara two\n\npara three";
    expect(mergeChatText(note, "para one\n\npara two").added).toBe("");
  });

  test("extending a note adds only the new paragraph", () => {
    const note = "para one\n\npara two";
    const r = mergeChatText(note, note + "\n\npara three");
    expect(r.added).toBe("para three");
    expect(r.merged).toBe("para one\n\npara two\n\npara three");
  });
});

// ── Nothing is ever lost ───────────────────────────────────────────

describe("mergeChatText — no data loss", () => {
  const cases: Array<[string, string, string]> = [
    ["delta", t(A, B), t(C, D)],
    ["identical", t(A, B), t(A, B)],
    ["overlapping", t(A, B), t(B, C)],
    ["older turns", t(C, D), t(A, B, C)],
    ["superset", t(C), t(A, B, C, D)],
    ["disjoint", t(A), t(D)],
    ["empty capture", t(A, B), ""],
    ["notes", "para one\n\npara two", "para two\n\npara three"],
  ];

  test.each(cases)("every stored turn survives a %s save", (_label, existing, incoming) => {
    const { merged } = mergeChatText(existing, incoming);
    for (const turn of splitTurns(existing)) {
      expect(merged).toContain(turn);
    }
  });

  test.each(cases)("every captured turn is present after a %s save", (_label, existing, incoming) => {
    const { merged } = mergeChatText(existing, incoming);
    for (const turn of splitTurns(incoming)) {
      expect(merged).toContain(turn);
    }
  });

  test("every turn reported as added is present in merged", () => {
    // `added` collects the new turns for fact extraction, so it is not
    // necessarily a contiguous slice of merged — a capture that supersedes the
    // stored run contributes turns from either side of it.
    for (const [, existing, incoming] of cases) {
      const { merged, added } = mergeChatText(existing, incoming);
      for (const turn of splitTurns(added)) {
        expect(merged).toContain(turn);
      }
    }
  });

  test("added is empty exactly when nothing new arrived", () => {
    expect(mergeChatText(t(A, B), t(A, B)).added).toBe("");
    expect(mergeChatText(t(A, B), "").added).toBe("");
    expect(mergeChatText(t(A, B), t(C)).added).not.toBe("");
  });
});
