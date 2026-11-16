import { stripEdgePunct } from './sentenceTokens';

/**
 * Looking up a phrase selected in a sentence (sentence review on a laptop: select the phrase, then Command/Ctrl-click
 * inside the selection). Pure, so the rules are pinned by node tests; views/detail/useSelectionLookup.ts reads the
 * selection and the pointer from the page.
 */

/** The longest selection, in words, looked up as one phrase; a longer one leaves the click to the word under it. */
export const MAX_SELECTION_WORDS = 6;

/**
 * What a selection looks up: its text with whitespace collapsed and punctuation trimmed from both ends, as a tapped
 * word's is (curly quotes and dashes too; letters, accented ones included, digits and straight apostrophes stay), when
 * it lies inside the sentence (`insideSentence`) and holds 1 to 6 words. Otherwise null, and the click looks up the word
 * under the pointer, as it did before.
 */
export function selectionLookupTerm(text: string, insideSentence: boolean): string | null {
  if (!insideSentence) return null;
  const term = stripEdgePunct(text.replace(/\s+/g, ' ').trim());
  // A dash standing between words is no word of its own.
  const words = term.split(' ').filter(piece => /[\p{L}\p{N}]/u.test(piece)).length;
  return words >= 1 && words <= MAX_SELECTION_WORDS ? term : null;
}

/**
 * Whether a selection is the sentence's: both its ends, where it was started (anchor) and where it was taken to
 * (focus), lie inside `sentence`, the element holding the sentence's words (views/detail/SentenceHero.tsx's
 * <p data-sentence-hero>). A selection that starts or ends anywhere else, in the IPA line under the sentence say, isn't.
 */
export function isSentenceSelection(anchor: Node | null, focus: Node | null, sentence: Pick<Node, 'contains'> | null): boolean {
  return !!anchor && !!focus && !!sentence && sentence.contains(anchor) && sentence.contains(focus);
}

/** The part of a DOMRect pointInRects reads. */
export interface RectEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Whether the point lies on one of the rects, give or take `slack` pixels: whether a click landed on the selection's
 * text (Range.getClientRects, a rect per line), the word padding at its edges included.
 */
export function pointInRects(x: number, y: number, rects: Iterable<RectEdges>, slack = 2): boolean {
  for (const rect of rects) {
    if (x >= rect.left - slack && x <= rect.right + slack && y >= rect.top - slack && y <= rect.bottom + slack) return true;
  }
  return false;
}
