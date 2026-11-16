/**
 * The paint a tap or click leaves on a sentence's word, so every word gesture answers within a frame, before any audio
 * or search does: a short indigo pulse when it plays from the word, a stronger flash with a ring when it looks the word
 * up, unlike the Command-hover preview (src/index.css: indigo-50 and an indigo-200 ring). Paint only, through
 * element.animate on the background and the box shadow: nothing moves, no React state changes, and each fades back to
 * the word's own style. The colors are Tailwind's.
 */

export type WordFlashKind = 'play' | 'lookup';

export interface WordFlashStyle {
  /** Only the starting keyframe: the flash fades from it to the word's own paint. */
  keyframes: Keyframe[];
  duration: number;
}

export const WORD_FLASH: Readonly<Record<WordFlashKind, WordFlashStyle>> = {
  // indigo-100
  play: { duration: 300, keyframes: [{ offset: 0, backgroundColor: 'oklch(93% 0.034 272.788)' }] },
  // indigo-200, with a 2 px indigo-500 ring
  lookup: {
    duration: 450,
    keyframes: [{ offset: 0, backgroundColor: 'oklch(87% 0.065 274.039)', boxShadow: '0 0 0 2px oklch(58.5% 0.233 277.117)' }],
  },
};

/** What flashWord needs of an element: Element.animate, which an old browser (or a test's stand-in) may lack. */
export interface Flashable {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Pick<Animation, 'cancel'>;
}

// The flash running on each word, so a new one replaces it rather than painting over it.
const running = new WeakMap<Flashable, Pick<Animation, 'cancel'>>();

/**
 * Flashes the word: its previous flash, if still running, stops, and this one starts from its first frame, so hitting
 * the same word again restarts it. Without element.animate, or when the browser refuses the keyframes, the word keeps
 * its paint and the gesture still acts.
 */
export function flashWord(word: Flashable | null | undefined, kind: WordFlashKind): void {
  if (!word || typeof word.animate !== 'function') return;
  running.get(word)?.cancel();
  const { keyframes, duration } = WORD_FLASH[kind];
  try {
    running.set(word, word.animate(keyframes, { duration, easing: 'ease-out' }));
  } catch {
    running.delete(word);
  }
}
