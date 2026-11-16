import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ItemGroup } from '../../types';
import { speakWord } from '../../services/neuralTts';

interface WordSlideshowOptions {
  isAutoPlaying: boolean;
  stopSlideshow: () => void;
  groups: ItemGroup[];
  currentGroupIndex: number;
  currentItemIndex: number;
  setCurrentGroupIndex: Dispatch<SetStateAction<number>>;
  setCurrentItemIndex: Dispatch<SetStateAction<number>>;
  /** How long each slide shows, read as each one starts. */
  autoPlaySpeedRef: RefObject<number>;
  /** The word on screen, pronounced again when a one-meaning word takes its second turn. */
  title: string;
  /** The card on screen (useCardNavigation's shownKey), whose turns the slideshow counts. */
  shownKey: string;
}

/**
 * The word slideshow: each card shows for the chosen time, then the next meaning, then the next word, until the
 * last card. A word with one meaning shows twice and is pronounced again, so every word plays at least twice.
 */
export function useWordSlideshow({
  isAutoPlaying, stopSlideshow, groups, currentGroupIndex, currentItemIndex, setCurrentGroupIndex,
  setCurrentItemIndex, autoPlaySpeedRef, title, shownKey,
}: WordSlideshowOptions) {
  // The turns the card on screen has had during auto-play: a word with one meaning needs a second, so it plays twice.
  // The count starts again when another card shows, not when the card only moves, as when a word before it leaves the
  // view, so a word on its second turn isn't given a third.
  const [cardTurns, setCardTurns] = useState(1);
  // Reads the count from the render that changed, and resets it only when needed; listing the count would undo every
  // increment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (cardTurns !== 1) setCardTurns(1); }, [shownKey, isAutoPlaying]);

  useEffect(() => {
    if (!isAutoPlaying || !groups) return;

    const timer = setTimeout(() => {
      const safeGroupIdx = Math.min(currentGroupIndex, groups.length - 1);
      const group = groups[safeGroupIdx];
      if (!group) { stopSlideshow(); return; }

      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      const needsRepeat = isLastItem && group.items.length < 2 && cardTurns < 2;

      if (!isLastItem) {
        // Advance to next meaning within current group
        setCurrentItemIndex(prev => prev + 1);
      } else if (needsRepeat) {
        // Single-meaning word: show it for another turn and re-pronounce
        setCardTurns(prev => prev + 1);
        if (title) speakWord(title);
      } else if (!isLastGroup) {
        // Advance to next group (word)
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0);
      } else {
        // Reached the end
        stopSlideshow();
      }
    }, autoPlaySpeedRef.current);

    return () => clearTimeout(timer);
    // The title follows from the cards and the indices, so listing it adds no restart.
  }, [isAutoPlaying, currentGroupIndex, currentItemIndex, groups, cardTurns, title, autoPlaySpeedRef, stopSlideshow, setCurrentGroupIndex, setCurrentItemIndex]);
}
