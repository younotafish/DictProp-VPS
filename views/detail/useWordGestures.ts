import { useRef, type Dispatch, type RefObject, type SetStateAction, type TouchEvent as ReactTouchEvent, type UIEvent as ReactUIEvent } from 'react';
import type { ItemGroup, SearchResult, StoredItem, VocabCard } from '../../types';
import { useZoneFlash } from '../../components/EyesFreeZones';
import { speakWord } from '../../services/neuralTts';
import { log } from '../../services/logger';
import { zoneText } from './cardReading';
import { touchFacts, wordTouchAction } from './touchGestures';

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
 * meaning closes the view, and a double click marks the card remembered. Scrolling down hides the header again.
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

  const onContentTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
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
    
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    // Edges are measured on the card's scroller, the page the touch moved.
    const facts = touchFacts(diffX, diffY, scrollContainerRef.current);
    // Controls keep their own handlers, so taps on them aren't gestures.
    const tapTarget = e.target as HTMLElement | null;
    const onControl = !!tapTarget?.closest(
      'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"]'
    );

    const action = wordTouchAction(facts, {
      onControl,
      y: e.changedTouches[0].clientY,
      viewportHeight: window.innerHeight,
      hasNextGroup,
      hasPrevGroup,
      hasPrevItem,
    });
    switch (action?.kind) {
      case 'read-zone': {
        flashZone(action.zone);
        const text = zoneText(currentItem, action.zone);
        if (text !== null) toggleSpeak(text);
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

  const handleDoubleClick = () => {
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
