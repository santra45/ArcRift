/**
 * mcp/tools/importance.ts — importance at the MCP boundary.
 *
 * Memories store importance as a number so they can be ordered and
 * thresholded, but picking 0.75 out of the air is an awkward thing to ask of
 * an assistant. Tools take the level names and convert here. A caller that
 * already has a score can pass the number straight through.
 */

export type ImportanceLevel = "critical" | "high" | "medium" | "low";

const LEVEL_SCORES: Record<ImportanceLevel, number> = {
  critical: 0.95,
  high: 0.75,
  medium: 0.5,
  low: 0.25
};

export const IMPORTANCE_LEVELS = Object.keys(LEVEL_SCORES) as ImportanceLevel[];

export const DEFAULT_IMPORTANCE: ImportanceLevel = "high";

const isLevel = (value: string): value is ImportanceLevel => value in LEVEL_SCORES;

/** Score for a level name or a raw number, clamped to the 0–1 the column holds. */
export function importanceToScore(value: ImportanceLevel | number = DEFAULT_IMPORTANCE): number {
  if (typeof value === "number") {
    // A NaN would be written as NULL and sort ahead of everything.
    if (!Number.isFinite(value)) return LEVEL_SCORES[DEFAULT_IMPORTANCE];
    return Math.max(0, Math.min(1, value));
  }

  const level = String(value).toLowerCase();
  return isLevel(level) ? LEVEL_SCORES[level] : LEVEL_SCORES[DEFAULT_IMPORTANCE];
}

/** How the importance reads back in a tool response: "HIGH", or the score. */
export function importanceLabel(value: ImportanceLevel | number = DEFAULT_IMPORTANCE): string {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  return isLevel(level) ? level.toUpperCase() : importanceToScore(value).toString();
}
