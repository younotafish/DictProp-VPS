/**
 * The rules that keep a review gesture from misfiring, apart from React and the DOM so node tests pin them: a
 * remember counts once per item and gesture, whatever else lands with it, never comes from a control, a double tap
 * in a word card's read bands leaves playback as it found it, and a tap that stops a fling does nothing else.
 */
import type { PlaybackState } from './audio/player';

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

/** What a read-band tap did to playback: started its sentence, or paused or resumed the one already playing. */
export type ZoneTapEffect = 'started' | 'paused' | 'resumed';

/**
 * What a read-band tap did to playback, read from the engine's state just before and just after it: a sentence
 * loading that wasn't was started (or restarted near its end), the same sentence going from playing to paused was
 * paused and from paused to playing resumed. Null when the tap changed nothing, as on a sentence still loading.
 */
export function zoneTapEffect(before: PlaybackState, after: PlaybackState): ZoneTapEffect | null {
  if (after.status === 'loading') return before.status === 'loading' && before.text === after.text ? null : 'started';
  if (before.text !== after.text) return null;
  if (before.status === 'playing' && after.status === 'paused') return 'paused';
  if (before.status === 'paused' && after.status === 'playing') return 'resumed';
  return null;
}

/** Two taps this close in time and space are a double tap. */
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 40;

/**
 * Whether a still tap at (x, y), `now` (the tap's event time), is the second of a double tap whose first was the
 * read-band tap `first`, and if so how to undo what that one did (`before`): stop what it started, resume what it
 * paused, pause what it resumed. A double tap is Got it, so it leaves playback as it found it. Null when there was
 * no such first tap or this one came more than 450 ms later or more than 40 px away.
 */
export function zoneDoubleTapUndo(
  first: { at: number; x: number; y: number; before: ZoneTapEffect } | null,
  now: number,
  x: number,
  y: number,
): 'stop' | 'resume' | 'pause' | null {
  if (!first || now - first.at > DOUBLE_TAP_MS || Math.abs(x - first.x) > DOUBLE_TAP_PX || Math.abs(y - first.y) > DOUBLE_TAP_PX) {
    return null;
  }
  switch (first.before) {
    case 'started': return 'stop';
    case 'paused': return 'resume';
    case 'resumed': return 'pause';
  }
}

/**
 * Whether a touch that began at `touchStartAt` landed on a page a fling was still moving: the page last scrolled, at
 * `lastScrollAt`, less than `windowMs` before (both are event times; -Infinity before any scroll). Such a tap only
 * stops the page, so if it stays still it neither plays nor pauses and doesn't count toward a double tap.
 */
export function isFlingStopTap(lastScrollAt: number, touchStartAt: number, windowMs = 120): boolean {
  return touchStartAt - lastScrollAt < windowMs;
}
