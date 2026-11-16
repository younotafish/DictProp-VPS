/**
 * Sync that retries: a push that fails is tried again on a backoff, from the background pull, instead of waiting for
 * the next change. What the user is told about it, the Sync now and stuck-sync pills, is in services/jobNotices.
 */

/** Pushes failing in a row: how many, when the first failed, and when the next try is due (null: none is). */
export interface PushTrouble { failures: number; firstFailureAt: number | null; nextRetryAt: number | null }

export const NO_TROUBLE: PushTrouble = { failures: 0, firstFailureAt: null, nextRetryAt: null };

// The wait before the first retry, doubling with each failure up to the longest.
const FIRST_RETRY_MS = 8_000;
const LONGEST_RETRY_MS = 5 * 60_000;

/** When the next try is due after `failures` failed pushes in a row, the last at `lastFailureAt`. */
export const nextRetryAt = (failures: number, lastFailureAt: number): number =>
  lastFailureAt + Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1));

/** A push failed at `now`: one more failure, and the next try further off. */
export const pushFailed = (trouble: PushTrouble, now: number): PushTrouble => ({
  failures: trouble.failures + 1,
  firstFailureAt: trouble.firstFailureAt ?? now,
  nextRetryAt: nextRetryAt(trouble.failures + 1, now),
});

/** A push reached the server, the items it refused included (a refusal is an answer, not a failure). */
export const pushSucceeded = (): PushTrouble => NO_TROUBLE;

/** The connection came back: after failures, the count starts over and a try is due at once. */
export const cameOnline = (trouble: PushTrouble, now: number): PushTrouble =>
  trouble.failures > 0 ? { failures: 0, firstFailureAt: null, nextRetryAt: now } : trouble;

/** Whether a push is due to be tried again at `now`. */
export const retryDue = (trouble: PushTrouble, now: number): boolean =>
  trouble.nextRetryAt !== null && now >= trouble.nextRetryAt;
