import { useEffect, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type RefObject, type SetStateAction, type TouchEvent as ReactTouchEvent, type UIEvent as ReactUIEvent } from 'react';
import type { ItemGroup, SearchResult, StoredItem, VocabCard } from '../../types';
import { useZoneFlash } from '../../components/EyesFreeZones';
import { getPlaybackState, pauseCurrent, resumeCurrent, speakWord, stopCurrent } from '../../services/neuralTts';
import { log } from '../../services/logger';
import {
  doubleTapControlSelector, isFlingStopTap, zoneDoubleTapUndo, zoneTapEffect, type ZoneTapEffect,
} from '../../services/reviewGestures';
import { zoneText } from './cardReading';
import { touchFacts, wordTouchAction } from './touchGestures';

// On a word card every control keeps its own taps, single or double: the native ones and the green look-up words.
const CARD_CONTROLS = doubleTapControlSelector('card');

interface WordGesturesOptions {
  scrollContainerRef: RefObject<HTMLElement | null>;
  showHeader: boolean;
  setShowHeader: Dispatch<SetStateAction<boolean>>;
  currentGroup: ItemGroup;
  currentItem: StoredItem;
  hasNextGroup: boolean;
  hasPrevGroup: boolean;
  hasPrevItem: boolean;
  setCurrentGroupIndex: Dispatch<SetStateAction<number>>;
  setCurrentItemIndex: Dispatch<SetStateAction<number>>;
  stopSlideshow: () => void;
  /** Reads an example sentence, or pauses, resumes or restarts it (useExampleSpeech). */
  toggleSpeak: (raw: string) => void;
  onClose: () => void;
  handleRemember: () => void;
}

/**
 * The word card's taps and swipes: eyes-free zone taps read the card's parts (see wordTouchAction), a short pull
 * down shows the header, ↑/↓ swipes move between words and ←/→ between meanings, a swipe right past the first
 * meaning closes the view, and a double click off the controls marks the card remembered; a double tap in the read
 * bands leaves playback as it found it, and a tap that stops a fling only stops it. Scrolling down hides the header
 * again.
 */
export function useWordGestures({
  scrollContainerRef, showHeader, setShowHeader, currentGroup, currentItem, hasNextGroup, hasPrevGroup, hasPrevItem,
  setCurrentGroupIndex, setCurrentItemIndex, stopSlideshow, toggleSpeak, onClose, handleRemember,
}: WordGesturesOptions) {
  const lastScrollY = useRef(0);
  const handleScroll = (e: ReactUIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const currentScrollY = target.scrollTop;

    // Header auto-hide logic: hide when scrolling down, but only show via gesture or keyboard
    if (showHeader && currentScrollY > lastScrollY.current && currentScrollY > 50) {
      setShowHeader(false);
    }
    
    lastScrollY.current = currentScrollY;
  };

  // Touch Handling for swipe navigation
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones). The guides only render on touch devices, since
  // those zones only fire from taps (a mouse click does nothing there).
  const { zoneFlash, flashZone } = useZoneFlash();
  // The last read-band tap that changed playback, while it may still be the first tap of a double tap: when and
  // where it landed and what it did, so the second tap can undo it (zoneDoubleTapUndo).
  const firstZoneTapRef = useRef<{ at: number; x: number; y: number; before: ZoneTapEffect } | null>(null);

  // When the card's page last scrolled, and whether the touch in progress landed while a fling still moved it.
  const lastScrollAtRef = useRef(-Infinity);
  const touchStoppedFlingRef = useRef(false);
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const noteScroll = (e: Event) => { lastScrollAtRef.current = e.timeStamp; };
    // Scroll events don't bubble; capturing them hears the page and anything that scrolls inside it.
    scroller.addEventListener('scroll', noteScroll, { capture: true, passive: true });
    return () => scroller.removeEventListener('scroll', noteScroll, { capture: true });
  }, [scrollContainerRef]);

  const onContentTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    touchStoppedFlingRef.current = isFlingStopTap(lastScrollAtRef.current, e.timeStamp);
  };
  
  const onContentTouchEnd = (e: ReactTouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    if (hasTextSelection) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    
    const touch = e.changedTouches[0];
    const diffX = touch.clientX - touchStartX.current;
    const diffY = touch.clientY - touchStartY.current;
    // Edges are measured on the card's scroller, the page the touch moved.
    const facts = touchFacts(diffX, diffY, scrollContainerRef.current);
    // A still tap that stopped a fling only stopped the page: it reads nothing and starts no double tap.
    if (facts.isStillTap && touchStoppedFlingRef.current) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    // Controls keep their own handlers, so taps on them aren't gestures.
    const tapTarget = e.target as HTMLElement | null;
    const onControl = !!tapTarget?.closest(CARD_CONTROLS);

    const action = wordTouchAction(facts, {
      onControl,
      y: touch.clientY,
      viewportHeight: window.innerHeight,
      hasNextGroup,
      hasPrevGroup,
      hasPrevItem,
    });
    if (action?.kind === 'read-zone') flashZone(action.zone);
    // A double tap is Got it (its dblclick records the remember), so its second tap undoes what the first did to
    // playback rather than toggling again: playback ends as the double tap found it, never paused mid-word or
    // loading a clip that plays after Remembered!.
    const firstZoneTap = firstZoneTapRef.current;
    firstZoneTapRef.current = null;
    const undo = facts.isStillTap && !onControl ? zoneDoubleTapUndo(firstZoneTap, e.timeStamp, touch.clientX, touch.clientY) : null;
    if (undo === 'stop') stopCurrent();
    else if (undo === 'resume') resumeCurrent();
    else if (undo === 'pause') pauseCurrent();
    else switch (action?.kind) {
      case 'read-zone': {
        const text = zoneText(currentItem, action.zone);
        if (text === null) break;
        const before = getPlaybackState();
        toggleSpeak(text);
        const effect = zoneTapEffect(before, getPlaybackState());
        if (effect) firstZoneTapRef.current = { at: e.timeStamp, x: touch.clientX, y: touch.clientY, before: effect };
        break;
      }
      case 'reveal-header':
        setShowHeader(true);
        break;
      case 'next-word':
        stopSlideshow();
        setShowHeader(false); // Hide header on navigation
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0); // Reset to first meaning
        break;
      case 'previous-word':
        stopSlideshow();
        setShowHeader(false); // Hide header on navigation
        setCurrentGroupIndex(prev => prev - 1);
        setCurrentItemIndex(0); // Reset to first meaning
        break;
      case 'next-meaning': {
        stopSlideshow();
        const totalItems = currentGroup.items.length;
        if (totalItems === 1) {
          // Single meaning: just pronounce, no scroll/animation reset
          const wordToSpeak = currentItem.type === 'phrase'
            ? (currentItem.data as SearchResult).query
            : (currentItem.data as VocabCard).word;
          if (wordToSpeak) speakWord(wordToSpeak);
        } else {
          setShowHeader(false);
          setCurrentItemIndex(prev => (prev + 1) % totalItems);
        }
        break;
      }
      case 'previous-meaning':
        stopSlideshow();
        setShowHeader(false); // Hide header on navigation
        setCurrentItemIndex(prev => prev - 1);
        break;
      case 'close':
        stopSlideshow();
        onClose(); // Swiping right past the first meaning closes the view
        break;
    }
    
    touchStartX.current = null;
    touchStartY.current = null;
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    // A double click on a control is two clicks on it, never Got it: double-tapping the trash, the speaker or a
    // look-up word doesn't review the card.
    if ((e.target as HTMLElement | null)?.closest(CARD_CONTROLS)) return;
    // Avoid triggering when selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
       return;
    }

    log('👆👆 DetailView: Double click detected');
    handleRemember();
  };

  return { zoneFlash, handleScroll, onContentTouchStart, onContentTouchEnd, handleDoubleClick };
}
