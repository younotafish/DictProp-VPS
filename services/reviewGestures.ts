/**
 * The rules that keep a review gesture from misfiring, apart from React and the DOM so node tests pin them: a
 * remember counts once per item and gesture, whatever else lands with it, and never comes from a control.
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

/** Native controls: a tap or click on one is the control's own, never a card gesture. */
export const TAP_CONTROL_SELECTOR = 'button, a, input, textarea, select, label, [contenteditable="true"]';

/**
 * What a double tap or double click mustn't land on to count as Got it: a control, whose two taps are its own. On a
 * word card ('card') the green look-up words, which are ARIA buttons, count as controls, as they do for its single
 * taps; in sentence review ('sentence') a double tap on the sentence's words still remembers, so only native
 * controls count.
 */
export function doubleTapControlSelector(mode: 'card' | 'sentence'): string {
  return mode === 'card' ? `${TAP_CONTROL_SELECTOR}, [role="button"]` : TAP_CONTROL_SELECTOR;
}
