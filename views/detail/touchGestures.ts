/**
 * What a finished one-finger touch on the card view means. The view measures the touch and, as it began, the scroller
 * it moved; these functions decide, so the thresholds and edge rules are pinned by tests rather than by reading.
 */
import { eyesFreeZoneAt } from '../../components/eyesFreeBands';
import { swipeDirection } from '../../components/swipeDirection';

/** A finger that moved no more than this either way is a tap, not a swipe or a scroll. */
const TAP_MOVE_MAX = 10;
/** A vertical swipe travels further than this. */
const SWIPE_MIN = 50;
/** Vertical swipes shorter than this are short (they reveal the word card's header)... */
const SHORT_SWIPE_MAX = 120;
/** ...and from this length on they're long, and change the card at the matching edge. */
const LONG_SWIPE_MIN = 120;
/** Horizontal swipes are more sensitive: anything past this changes the page or the meaning. */
const HORIZONTAL_SWIPE_MIN = 60;
/** A scroller within this many pixels of an end counts as at that end. */
const EDGE_SLACK = 5;

export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Where a scroller stands. */
export interface ScrollEdges {
  /** At its top... */
  atTop: boolean;
  /** ...or its bottom... */
  atBottom: boolean;
  /** ...or holding content no taller than the page. A missing scroller counts as all three. */
  fits: boolean;
}

/** Where `scroller` stands, with five pixels of slack at each end. */
export function scrollEdges(scroller: ScrollPosition | null): ScrollEdges {
  const scrollTop = scroller?.scrollTop || 0;
  const scrollHeight = scroller?.scrollHeight || 0;
  const clientHeight = scroller?.clientHeight || 0;
  return {
    atTop: scrollTop <= EDGE_SLACK,
    atBottom: scrollTop + clientHeight >= scrollHeight - EDGE_SLACK,
    fits: scrollHeight <= clientHeight,
  };
}

/** A finished touch: how far it moved, what kind of gesture that makes, and where its scroller stood when it began. */
export interface TouchFacts extends ScrollEdges {
  dx: number;
  dy: number;
  isStillTap: boolean;
  isVerticalSwipe: boolean;
  isShortSwipe: boolean;
  isLongSwipe: boolean;
  isHorizontalSwipe: boolean;
}

/**
 * Classifies a touch that moved `dx`, `dy` over `scroller` (the card's, the sentence page's or the analysis page's).
 * The edges are `start`, the scroller's as the touch began, so a long swipe changes the card only when it starts at
 * the matching edge, and a drag that reaches an edge partway only scrolls; without a snapshot they're `scroller`'s now.
 */
export function touchFacts(dx: number, dy: number, scroller: ScrollPosition | null, start?: ScrollEdges): TouchFacts {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const { atTop, atBottom, fits } = start ?? scrollEdges(scroller);
  return {
    dx,
    dy,
    isStillTap: absX <= TAP_MOVE_MAX && absY <= TAP_MOVE_MAX,
    isVerticalSwipe: absY > absX * 1.5 && absY > SWIPE_MIN,
    isShortSwipe: absY >= SWIPE_MIN && absY < SHORT_SWIPE_MAX,
    isLongSwipe: absY >= LONG_SWIPE_MIN,
    isHorizontalSwipe: swipeDirection(dx, dy, HORIZONTAL_SWIPE_MIN) !== null,
    atTop,
    atBottom,
    fits,
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
 * swipes change sentences, but only when they start at the page's matching end, so ordinary drags just scroll.
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
 * short swipe down that starts at the top reveals the header; long vertical swipes change words when they start at
 * the matching end; a sideways swipe changes the meaning, and past the first meaning a swipe right leaves.
 */
export function wordTouchAction(
  facts: TouchFacts,
  { onControl, y, viewportHeight, hasNextGroup, hasPrevGroup, hasPrevItem }:
    { onControl: boolean; y: number; viewportHeight: number; hasNextGroup: boolean; hasPrevGroup: boolean; hasPrevItem: boolean },
): WordTouchAction {
  if (facts.isStillTap) {
    if (onControl) return null;
    const zone = eyesFreeZoneAt(y, viewportHeight);
    return zone === -1 ? null : { kind: 'read-zone', zone };
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
