/**
 * What a finished one-finger touch on the card view means. The view measures the touch and the scroller it
 * moved; these functions decide, so the thresholds and edge rules are pinned by tests rather than by reading.
 */

/** A finger that moved no more than this either way is a tap, not a swipe or a scroll. */
export const TAP_MOVE_MAX = 10;
/** A vertical swipe travels further than this. */
export const SWIPE_MIN = 50;
/** Vertical swipes shorter than this are short (they reveal the word card's header)... */
export const SHORT_SWIPE_MAX = 120;
/** ...and from this length on they're long, and change the card at the matching edge. */
export const LONG_SWIPE_MIN = 120;
/** Horizontal swipes are more sensitive: anything past this changes the page or the meaning. */
export const HORIZONTAL_SWIPE_MIN = 60;
/** A scroller within this many pixels of an end counts as at that end. */
const EDGE_SLACK = 5;

export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface TouchFacts {
  dx: number;
  dy: number;
  isStillTap: boolean;
  isVerticalSwipe: boolean;
  isShortSwipe: boolean;
  isLongSwipe: boolean;
  isHorizontalSwipe: boolean;
  /** The scroller the touch moved is at its top... */
  atTop: boolean;
  /** ...or its bottom... */
  atBottom: boolean;
  /** ...or its content is no taller than the page. A missing scroller counts as all three. */
  fits: boolean;
}

/** Classifies a touch that moved `dx`, `dy` over `scroller` (the card's, or the analysis page's). */
export function touchFacts(dx: number, dy: number, scroller: ScrollPosition | null): TouchFacts {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const scrollTop = scroller?.scrollTop || 0;
  const scrollHeight = scroller?.scrollHeight || 0;
  const clientHeight = scroller?.clientHeight || 0;
  return {
    dx,
    dy,
    isStillTap: absX <= TAP_MOVE_MAX && absY <= TAP_MOVE_MAX,
    isVerticalSwipe: absY > absX * 1.5 && absY > SWIPE_MIN,
    isShortSwipe: absY >= SWIPE_MIN && absY < SHORT_SWIPE_MAX,
    isLongSwipe: absY >= LONG_SWIPE_MIN,
    isHorizontalSwipe: absX > absY * 1.5 && absX > HORIZONTAL_SWIPE_MIN,
    atTop: scrollTop <= EDGE_SLACK,
    atBottom: scrollTop + clientHeight >= scrollHeight - EDGE_SLACK,
    fits: scrollHeight <= clientHeight,
  };
}

export type SentenceTouchAction =
  | 'show-sentence'
  | 'show-analysis'
  | 'open-auto-play-panel'
  | 'close'
  | 'surface-tap'
  | 'next'
  | 'previous'
  | null;

/**
 * Sentence review, on either page. Sideways flips between the sentence and its analysis; past the sentence
 * page's left edge it leaves, unless auto-play is locked on, when it opens the auto-play panel. A still tap on
 * blank space plays, pauses or (twice) remembers; controls and words keep their own handlers. Long vertical
 * swipes change sentences, but only once the page has reached the matching end, so ordinary drags just scroll.
 */
export function sentenceTouchAction(
  facts: TouchFacts,
  { onAnalysisPage, autoPlaying, onControl, onSentenceWord }:
    { onAnalysisPage: boolean; autoPlaying: boolean; onControl: boolean; onSentenceWord: boolean },
): SentenceTouchAction {
  if (facts.isHorizontalSwipe) {
    if (onAnalysisPage) return 'show-sentence';
    if (facts.dx < 0) return 'show-analysis';
    return autoPlaying ? 'open-auto-play-panel' : 'close';
  }
  if (facts.isStillTap && !onControl && !onSentenceWord) return 'surface-tap';
  if (facts.isVerticalSwipe && facts.isLongSwipe) {
    if (facts.dy < -LONG_SWIPE_MIN && (facts.atBottom || facts.fits)) return 'next';
    if (facts.dy > LONG_SWIPE_MIN && facts.atTop) return 'previous';
  }
  return null;
}

export type WordTouchAction =
  | { kind: 'read-zone'; zone: 0 | 1 }
  | { kind: 'reveal-header' }
  | { kind: 'next-word' }
  | { kind: 'previous-word' }
  | { kind: 'next-meaning' }
  | { kind: 'previous-meaning' }
  | { kind: 'close' }
  | null;

/**
 * A word or phrase card. A still tap off the controls reads by a fixed screen band in the top half: the top
 * quarter reads the first example, the second quarter the second, and the bottom half is safe empty space. A
 * short swipe down at the top reveals the header; long vertical swipes change words at the matching end; a
 * sideways swipe changes the meaning, and past the first meaning a swipe right leaves.
 */
export function wordTouchAction(
  facts: TouchFacts,
  { onControl, y, viewportHeight, hasNextGroup, hasPrevGroup, hasPrevItem }:
    { onControl: boolean; y: number; viewportHeight: number; hasNextGroup: boolean; hasPrevGroup: boolean; hasPrevItem: boolean },
): WordTouchAction {
  if (facts.isStillTap) {
    if (onControl) return null;
    if (y < viewportHeight / 4) return { kind: 'read-zone', zone: 0 };
    if (y < viewportHeight / 2) return { kind: 'read-zone', zone: 1 };
    return null;
  }
  if (facts.isVerticalSwipe && facts.isShortSwipe && facts.dy > 0 && facts.atTop) return { kind: 'reveal-header' };
  if (facts.isVerticalSwipe) {
    if (!facts.isLongSwipe) return null;
    if (facts.dy < -LONG_SWIPE_MIN && hasNextGroup && (facts.atBottom || facts.fits)) return { kind: 'next-word' };
    if (facts.dy > LONG_SWIPE_MIN && hasPrevGroup && facts.atTop) return { kind: 'previous-word' };
    return null;
  }
  if (facts.isHorizontalSwipe) {
    if (facts.dx < -HORIZONTAL_SWIPE_MIN) return { kind: 'next-meaning' };
    if (facts.dx > HORIZONTAL_SWIPE_MIN) return hasPrevItem ? { kind: 'previous-meaning' } : { kind: 'close' };
  }
  return null;
}
