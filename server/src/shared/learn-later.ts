// Learn later: the stars the learner puts on their own sentences in the sentence lesson (L, or the star in its bottom
// row), one of the signals the study model learns from (study-events.ts). A star lives outside item data, in its own
// table (server/src/db/learn-later.ts), so it never meets item sync's conflict rules: each star or unstar carries the
// time it was made, and the later one wins, wherever it was made. The client keeps the stars it knows and the changes
// it hasn't sent (services/learnLater.ts).

/** One star set or taken away. */
export interface LearnLaterChange {
  itemId: string;
  starred: boolean;
  /** When the learner made it (ms since the epoch); the later change of an item wins. */
  changedAt: number;
}

/** GET /api/learn-later: every item's latest change, starred or not, keyed by item id. */
export interface LearnLaterResponse {
  items: Record<string, { starred: boolean; changedAt: number }>;
}

/**
 * PUT /api/learn-later's answer: how many changes it took and refused, and each touched item's state as the server now
 * holds it, so a change that lost to a later one (another device, a faster clock) shows the winner at once.
 */
export interface LearnLaterSaveResponse extends LearnLaterResponse {
  accepted: number;
  rejected: number;
}

export const MAX_LEARN_LATER_CHANGES_PER_REQUEST = 200;

/** A well-formed change, or null. */
export function parseLearnLaterChange(value: unknown): LearnLaterChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { itemId, starred, changedAt } = value as Record<string, unknown>;
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 200) return null;
  if (typeof starred !== 'boolean') return null;
  if (!Number.isSafeInteger(changedAt) || (changedAt as number) < 0) return null;
  return { itemId, starred, changedAt: changedAt as number };
}
