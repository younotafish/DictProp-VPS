// The fields of a stored item that the corpus-audit import and the repair rebuild before writing the item back.

/** `value` when it is a finite, non-negative number, else `fallback`. */
export const finiteNonNegative = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/** The SRS counters validateStoredItem requires to be finite and non-negative (validation.ts lists them too). */
export const SRS_COUNTERS = [
  'nextReview', 'interval', 'memoryStrength', 'lastReviewDate', 'totalReviews', 'correctStreak', 'stability',
] as const;

/**
 * The SRS record to store for an item: `source`'s fields with the item's identity, and every counter made finite and
 * non-negative (0 when it isn't). `source` defaults to the item's own record.
 */
export function normalizedSrs(
  item: { type: string; data: { id: string }; srs?: unknown },
  source = (item.srs || {}) as Record<string, unknown>,
): Record<string, unknown> {
  const srs: Record<string, unknown> = { ...source, id: item.data.id, type: item.type };
  for (const field of SRS_COUNTERS) srs[field] = finiteNonNegative(source[field]);
  return srs;
}

/** An updatedAt after the stored one, so the write carrying it is never taken for stale content. */
export const nextUpdatedAt = (stored: unknown, now = Date.now()): number => Math.max(now, finiteNonNegative(stored) + 1);
