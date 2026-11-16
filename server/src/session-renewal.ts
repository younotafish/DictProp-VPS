// How long a sign-in lasts, and how using it extends it. Import-free, so it loads without opening the database.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a sign-in lasts from when it was made or last renewed: the session row's expiry and the cookie's Max-Age. */
export const SESSION_LIFETIME_MS = 30 * DAY_MS;

/**
 * A session with less than this left is renewed by its next API request. Against the 30-day lifetime, a session in
 * daily use is written at most once a week.
 */
export const RENEW_BELOW_MS = 23 * DAY_MS;

/** How long after the sign-in a session can last however often it's used. Then the owner signs in again. */
export const SESSION_CAP_MS = 180 * DAY_MS;

/**
 * The expiry a session in use moves to, or null to leave it: an expired session never comes back, one with
 * RENEW_BELOW_MS or more left needs nothing yet, and one already at its cap can't move. Otherwise it gets a full
 * lifetime from now, but never more than SESSION_CAP_MS after it was created.
 */
export function renewedExpiry(expiresAt: number, createdAt: number, now: number): number | null {
  if (expiresAt <= now || expiresAt - now >= RENEW_BELOW_MS) return null;
  const next = Math.min(now + SESSION_LIFETIME_MS, createdAt + SESSION_CAP_MS);
  return next > expiresAt ? next : null;
}
