/**
 * Repeat guards for presses that act on the item on screen. Each keeps the time of the last press it let through in a
 * ref that starts at -Infinity, so the first press always acts. Only lazily loaded screens (the card view, the lists)
 * import this file: an import from the first chunk would put the guards in it (test/client/entry-graph.test.ts).
 */

/**
 * Whether a press at `now` acts: only once `windowMs` or more has passed since the last press that did, which then
 * becomes this one (`lastAtRef.current = now`). A press that doesn't act leaves the ref alone.
 */
export function acceptRepeat(lastAtRef: { current: number }, now: number, windowMs: number): boolean {
  if (now - lastAtRef.current < windowMs) return false;
  lastAtRef.current = now;
  return true;
}

/**
 * One delete, archive or reset per press: another within 0.7 s is ignored, like the second tap of a double tap on the
 * trash, which would land on the card that slid into the first one's place.
 */
export function acceptDestructive(lastAtRef: { current: number }, now: number, windowMs = 700): boolean {
  return acceptRepeat(lastAtRef, now, windowMs);
}

/** One Reviewed per press in a list: another within 0.5 s, like a double click's second click, is ignored. */
export function acceptListReview(lastAtRef: { current: number }, now: number, windowMs = 500): boolean {
  return acceptRepeat(lastAtRef, now, windowMs);
}
