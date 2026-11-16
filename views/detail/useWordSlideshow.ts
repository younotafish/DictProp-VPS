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
}

/**
 * The word slideshow: each card shows for the chosen time, then the next meaning, then the next word, until the
 * last card. A word with one meaning shows twice and is pronounced again, so every word plays at least twice.
 */
export function useWordSlideshow({
  isAutoPlaying, stopSlideshow, groups, currentGroupIndex, currentItemIndex, setCurrentGroupIndex,
  setCurrentItemIndex, autoPlaySpeedRef, title,
}: WordSlideshowOptions) {
  // Counts displays of the current group during auto-play. Single-meaning words
  // need a second display to satisfy "play each word at least twice".
  const [groupPlayCount, setGroupPlayCount] = useState(1);
  // Reads the count from the render that moved, and resets it only when needed (see the group reset in
  // useCardNavigation); listing the count would undo every increment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (groupPlayCount !== 1) setGroupPlayCount(1); }, [currentGroupIndex, isAutoPlaying]);

  useEffect(() => {
    if (!isAutoPlaying || !groups) return;

    const timer = setTimeout(() => {
      const safeGroupIdx = Math.min(currentGroupIndex, groups.length - 1);
      const group = groups[safeGroupIdx];
      if (!group) { stopSlideshow(); return; }

      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      const needsRepeat = isLastItem && group.items.length < 2 && groupPlayCount < 2;

      if (!isLastItem) {
        // Advance to next meaning within current group
        setCurrentItemIndex(prev => prev + 1);
        setGroupPlayCount(prev => prev + 1);
      } else if (needsRepeat) {
        // Single-meaning word: show it for another turn and re-pronounce
        setGroupPlayCount(prev => prev + 1);
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
  }, [isAutoPlaying, currentGroupIndex, currentItemIndex, groups, groupPlayCount, title, autoPlaySpeedRef, stopSlideshow, setCurrentGroupIndex, setCurrentItemIndex]);
}
