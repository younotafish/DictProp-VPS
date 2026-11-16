import { useCallback, useEffect, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type RefObject, type SetStateAction, type TouchEvent as ReactTouchEvent } from 'react';
import { log } from '../../services/logger';
import { TAP_CONTROL_SELECTOR, doubleTapControlSelector, isFlingStopTap } from '../../services/reviewGestures';
import { scrollEdges, sentenceTouchAction, touchFacts, type ScrollEdges } from './touchGestures';
import { flashWord } from './wordFlash';

interface SentenceGesturesOptions {
  /** The view's root: a scroll anywhere in it (the sentence's page or the analysis) means a fling may be under way. */
  rootRef: RefObject<HTMLElement | null>;
  /** The sentence page's scroller: a long swipe on that page scrolls it to its end before changing sentences. */
  heroScrollRef: RefObject<HTMLElement | null>;
  /** Phones and tablets: two-finger word chords, and word clicks that arrive as taps. */
  isMobile: boolean;
  sentencePage: 'sentence' | 'analysis';
  setSentencePage: Dispatch<SetStateAction<'sentence' | 'analysis'>>;
  isSentenceAutoPlayingRef: RefObject<boolean>;
  setShowSentenceAutoPlayPanel: Dispatch<SetStateAction<boolean>>;
  onClose: () => void;
  currentGroupIndexRef: RefObject<number>;
  goToSentence: (nextIndex: number) => void;
  handleRemember: () => void;
  toggleSentencePlayback: () => void;
  playFromWordOffset: (offset: number) => void;
  /**
   * A laptop's Command/Ctrl-click inside a phrase selected in the sentence: looks the phrase up and says whether it did
   * (useSelectionLookup). When it didn't, the click looks up the word under the pointer.
   */
  lookUpSelection: () => boolean;
}

/**
 * Sentence review's taps, clicks and swipes, eyes-free like the word card: a still tap on blank space plays,
 * pauses or resumes the sentence (unless it only stops a fling) and a double tap off the controls (on the sentence's
 * words too) marks it remembered; ←/→ swipes switch between the sentence and its analysis, ↑/↓ swipes between
 * sentences. A tap or click on a word plays from it; a two-finger chord on a word (⌘-click on a laptop) runs the
 * word's lookup. Either way the word flashes at once (wordFlash.ts), before the audio or the search answers.
 */
export function useSentenceGestures({
  rootRef, heroScrollRef, isMobile, sentencePage, setSentencePage, isSentenceAutoPlayingRef, setShowSentenceAutoPlayPanel,
  onClose, currentGroupIndexRef, goToSentence, handleRemember, toggleSentencePlayback, playFromWordOffset, lookUpSelection,
}: SentenceGesturesOptions) {
  // Touch Handling for swipe navigation
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  // Where the page the touch moves stood as it began: a long swipe changes the sentence only from the matching edge.
  const touchStartEdgesRef = useRef<ScrollEdges | null>(null);
  // The page a touch moves: the analysis page, or the sentence page's scroller.
  const pageScroller = () => sentencePage === 'analysis'
    ? document.querySelector<HTMLElement>('[data-sentence-analysis]')
    : heroScrollRef.current;
  // A two-finger word chord (lookup) owns both touch endings; blank-space sentence gestures must ignore them.
  const mobileWordChordActiveRef = useRef(false);
  const suppressMobileWordClickUntilRef = useRef(0);
  useEffect(() => {
    const finishMobileWordChord = (e: TouchEvent) => {
      if (!mobileWordChordActiveRef.current || e.touches.length > 0) return;
      mobileWordChordActiveRef.current = false;
      suppressMobileWordClickUntilRef.current = Date.now() + 500;
    };
    window.addEventListener('touchend', finishMobileWordChord, { passive: true });
    window.addEventListener('touchcancel', finishMobileWordChord, { passive: true });
    return () => {
      window.removeEventListener('touchend', finishMobileWordChord);
      window.removeEventListener('touchcancel', finishMobileWordChord);
    };
  }, []);
  // Eyes-free taps: last tap (time + position) so a quick second tap reads as a double-tap.
  const lastSentenceTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const sentenceSingleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressSentenceSurfaceClickUntilRef = useRef(0);
  const cancelPendingSentenceSingleTap = useCallback(() => {
    if (sentenceSingleTapTimerRef.current) clearTimeout(sentenceSingleTapTimerRef.current);
    sentenceSingleTapTimerRef.current = null;
    lastSentenceTapRef.current = null;
  }, []);
  const queueSentenceSurfaceTap = (x: number, y: number) => {
    const now = Date.now();
    const previous = lastSentenceTapRef.current;
    const isDoubleTap = !!previous && now - previous.t < 320 &&
      Math.abs(x - previous.x) < 40 && Math.abs(y - previous.y) < 40;
    if (isDoubleTap) {
      cancelPendingSentenceSingleTap();
      handleRemember();
      return;
    }

    // Preserve an unrelated first tap before beginning a new double-tap window.
    if (sentenceSingleTapTimerRef.current) {
      clearTimeout(sentenceSingleTapTimerRef.current);
      sentenceSingleTapTimerRef.current = null;
      toggleSentencePlayback();
    }
    lastSentenceTapRef.current = { t: now, x, y };
    sentenceSingleTapTimerRef.current = setTimeout(() => {
      sentenceSingleTapTimerRef.current = null;
      lastSentenceTapRef.current = null;
      toggleSentencePlayback();
    }, 320);
  };
  useEffect(() => () => cancelPendingSentenceSingleTap(), [cancelPendingSentenceSingleTap]);

  // When the view last scrolled, and whether the touch in progress landed while a fling still moved a page.
  const lastScrollAtRef = useRef(-Infinity);
  const touchStoppedFlingRef = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const noteScroll = (e: Event) => { lastScrollAtRef.current = e.timeStamp; };
    // Scroll events don't bubble; capturing them on the root hears every page in the view.
    root.addEventListener('scroll', noteScroll, { capture: true, passive: true });
    return () => root.removeEventListener('scroll', noteScroll, { capture: true });
  }, [rootRef]);

  const onContentTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    touchStartEdgesRef.current = scrollEdges(pageScroller());
    touchStoppedFlingRef.current = isFlingStopTap(lastScrollAtRef.current, e.timeStamp);
  };

  const onContentTouchEnd = (e: ReactTouchEvent) => {
    if (mobileWordChordActiveRef.current) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    if (touchStartX.current === null || touchStartY.current === null) return;

    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    if (hasTextSelection) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    // Edges are the page the touch moved, as it stood when the touch began: a long swipe scrolls a long sentence or
    // analysis to its end, and the next one from there changes sentences.
    const facts = touchFacts(diffX, diffY, pageScroller(), touchStartEdgesRef.current ?? undefined);
    // A still tap that stopped a fling only stopped the page: it neither plays nor pauses and starts no double tap,
    // and a click the browser may still make of it is swallowed like a tap's.
    if (facts.isStillTap && touchStoppedFlingRef.current) {
      suppressSentenceSurfaceClickUntilRef.current = Date.now() + 500;
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    // Controls and the sentence's words keep their own handlers, so taps on them aren't gestures. (Every look-up
    // word, the ARIA buttons among them, carries data-word-offset.)
    const tapTarget = e.target as HTMLElement | null;
    const onControl = !!tapTarget?.closest(TAP_CONTROL_SELECTOR);
    const onSentenceWord = !!tapTarget?.closest('[data-word-offset]');

    // A still one-finger tap on blank space toggles natural-voice playback — play → pause → resume; a
    // double-tap marks the sentence remembered (same as the item-review double-click). Clickable words and
    // controls keep their own handlers; ↑/↓ swipes still switch sentences.
    switch (sentenceTouchAction(facts, {
      onAnalysisPage: sentencePage === 'analysis',
      autoPlaying: isSentenceAutoPlayingRef.current,
      onControl,
      onSentenceWord,
    })) {
      case 'show-sentence': setSentencePage('sentence'); break;
      case 'show-analysis': setSentencePage('analysis'); break;
      case 'open-auto-play-panel': setShowSentenceAutoPlayPanel(true); break;
      case 'close': onClose(); break;
      case 'surface-tap':
        suppressSentenceSurfaceClickUntilRef.current = Date.now() + 500;
        queueSentenceSurfaceTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        break;
      case 'next': goToSentence(currentGroupIndexRef.current + 1); break;      // swipe up → next sentence
      case 'previous': goToSentence(currentGroupIndexRef.current - 1); break;  // swipe down → previous sentence
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  // Mobile sentence words have fixed gestures: one finger plays from the tapped word; holding a finger
  // anywhere and touching a word with another runs the word's lookup action rendered by HighlightedSentence
  // (search an unsaved word, open a saved word's or phrase's card).
  const mobileLookupClickRef = useRef(false);
  const handleMobileWordTouchStart = (e: ReactTouchEvent<HTMLElement>) => {
    if (!isMobile || e.touches.length < 2) return;
    const target = e.target instanceof Element ? e.target : null;
    const word = target?.closest('[data-word-offset]') as HTMLElement | null;
    if (!word || !e.currentTarget.contains(word)) return;
    // React's touch listeners are passive, so nothing here can cancel the touch. Stopping it keeps the blank-space
    // gestures from seeing the chord, and the click-suppression window below swallows the clicks that follow it.
    e.stopPropagation();
    mobileWordChordActiveRef.current = true;
    suppressMobileWordClickUntilRef.current = Date.now() + 800;
    lastSentenceTapRef.current = null;
    // The word's handler looks nothing up while text is selected, so the word flashes only when it will.
    if (!window.getSelection()?.toString().trim()) flashWord(word, 'lookup');
    // A synchronous synthetic click reaches the word's own lookup handler; the capture handler lets it pass.
    mobileLookupClickRef.current = true;
    try {
      word.click();
    } finally {
      mobileLookupClickRef.current = false;
    }
  };

  const handleMobileWordClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (mobileLookupClickRef.current) return;
    if (mobileWordChordActiveRef.current || Date.now() < suppressMobileWordClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    playFromClickedWord(e);
  };

  // Words render in look-up mode; a plain click is taken here, before the word's own handler, and plays
  // from the clicked word instead.
  const playFromClickedWord = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target instanceof Element ? e.target : null;
    const word = target?.closest('[data-word-offset]') as HTMLElement | null;
    if (!word || !e.currentTarget.contains(word)) return;
    e.preventDefault();
    e.stopPropagation();
    if (window.getSelection()?.toString().trim()) return; // finishing a text selection, not a tap
    const offset = Number(word.dataset.wordOffset);
    if (!Number.isFinite(offset)) return;
    flashWord(word, 'play');
    playFromWordOffset(offset);
  };

  // Laptops mirror the phone gestures: a click plays from the clicked word, like a one-finger tap, and
  // Command-click (Ctrl-click off macOS) runs the word's lookup action, like a two-finger tap.
  const handleSentenceWordClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (isMobile) {
      handleMobileWordClickCapture(e);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      // Inside a phrase selected in the sentence, the phrase is looked up instead, so the word's handler stays out.
      if (lookUpSelection()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // The word's own handler looks it up; it flashes now, unless text still selected keeps that handler from acting.
      const target = e.target instanceof Element ? e.target : null;
      const word = target?.closest('[data-word-offset]') as HTMLElement | null;
      if (word && e.currentTarget.contains(word) && !window.getSelection()?.toString().trim()) flashWord(word, 'lookup');
      return;
    }
    playFromClickedWord(e);
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    // A double click on a control is two clicks on it, never Got it: double-tapping the speaker, Copy, Reset or a
    // term's search button doesn't review the sentence. Its words aren't controls here, so a double tap on them does,
    // while a laptop's double click on a word selects the word, and the selection check below leaves it at that.
    if ((e.target as HTMLElement | null)?.closest(doubleTapControlSelector('sentence'))) return;
    // Avoid triggering when selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
       return;
    }

    log('👆👆 DetailView: Double click detected');
    cancelPendingSentenceSingleTap();
    handleRemember();
  };

  const handleSentenceSurfaceClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() < suppressSentenceSurfaceClickUntilRef.current) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(`${TAP_CONTROL_SELECTOR}, [data-word-offset]`)) return;
    queueSentenceSurfaceTap(e.clientX, e.clientY);
  };

  return {
    onContentTouchStart, onContentTouchEnd, handleMobileWordTouchStart, handleSentenceWordClickCapture,
    handleDoubleClick, handleSentenceSurfaceClick,
  };
}
