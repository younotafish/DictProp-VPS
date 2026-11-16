/**
 * The rules that keep a review gesture from misfiring, apart from React and the DOM so node tests pin them: a
 * remember counts once per item and gesture, whatever else lands with it.
 */

/**
 * Whether a remember of `id` at `now` (any clock in milliseconds that only moves forward) counts, given the last one
 * that did. Only the same item within `windowMs` is refused, as when a touch double-tap and the dblclick the browser
 * makes of it both land; another item always counts, so R, ↓, R reviews both cards however fast it's pressed. The
 * caller records { id, at: now } as the last remember when this says yes.
 */
export function acceptRemember(last: { id: string; at: number } | null, id: string, now: number, windowMs = 1500): boolean {
  return !last || last.id !== id || now - last.at >= windowMs;
}
