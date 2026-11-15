import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ItemGroup } from '../../types';

interface CardNavigationOptions {
  initialGroupIndex: number;
  initialItemIndex: number;
  /** A new value moves the view to initialGroupIndex/initialItemIndex (see DetailViewProps). */
  navigationKey: number | undefined;
  /** The card's scroller, put back at its top whenever the view arrives at another card. Sentence review has none. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** Sentence review keeps its analysis page open between sentences, scrolled back to the top. */
  sentenceReview: boolean;
}

/**
 * Where the view is in its cards: a group (one word, or one sentence in sentence review) and a card inside it
 * (one meaning). The indices start from the caller's and can outrun groups that a delete or archive shrank, so
 * what's shown is clamped, and the indices are brought back in range after the render.
 */
export function useCardNavigation(
  groups: ItemGroup[],
  { initialGroupIndex, initialItemIndex, navigationKey, scrollContainerRef, sentenceReview }: CardNavigationOptions,
) {
  const [currentGroupIndex, setCurrentGroupIndex] = useState(initialGroupIndex);
  const [currentItemIndex, setCurrentItemIndex] = useState(initialItemIndex);

  // Determine current item to display. The indices start from the caller's and can outrun groups that a
  // delete or archive shrank, so what's shown is clamped here and the indices themselves just below.
  const safeGroupIndex = Math.max(0, Math.min(currentGroupIndex, groups.length - 1));
  const currentGroup = groups[safeGroupIndex];
  const safeItemIndex = Math.max(0, Math.min(currentItemIndex, currentGroup.items.length - 1));
  const currentItem = currentGroup.items[safeItemIndex];
  const hasNextGroup = safeGroupIndex < groups.length - 1;
  const hasPrevGroup = safeGroupIndex > 0;
  const hasPrevItem = safeItemIndex > 0;

  // The dots, the "i / N" counter and stepping back read the indices, so bring them back in range too.
  useLayoutEffect(() => {
    if (currentGroupIndex !== safeGroupIndex) setCurrentGroupIndex(safeGroupIndex);
    if (currentItemIndex !== safeItemIndex) setCurrentItemIndex(safeItemIndex);
  }, [currentGroupIndex, safeGroupIndex, currentItemIndex, safeItemIndex]);

  // Reset item index and scroll when user navigates to a different group (not on groups rebuild). Every
  // way of moving between words lands here, and the layout effect paints the new one from its top. The
  // resets are skipped when already in place: setting a state to its current value right after a render
  // still runs this whole component again.
  const prevGroupIndexRef = useRef(currentGroupIndex);
  // A move to a given card (navigationKey, below) lands on that card's sense rather than the first.
  const pendingItemIndexRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (prevGroupIndexRef.current !== currentGroupIndex) {
      prevGroupIndexRef.current = currentGroupIndex;
      if (scrollContainerRef?.current) scrollContainerRef.current.scrollTop = 0;
      // The analysis page stays open while moving between saved sentences, scrolled back to its top. (Word
      // cards never leave their one page.)
      if (sentenceReview) {
        const analysisScroller = document.querySelector<HTMLElement>('[data-sentence-analysis]');
        if (analysisScroller) analysisScroller.scrollTop = 0;
      }
      const itemIndex = pendingItemIndexRef.current ?? 0;
      pendingItemIndexRef.current = null;
      if (currentItemIndex !== itemIndex) setCurrentItemIndex(itemIndex);
    }
  }, [currentGroupIndex, sentenceReview, currentItemIndex, scrollContainerRef]);

  // The caller moves the view by changing navigationKey. Declared after the two effects above, so its
  // indices win over theirs when the groups change in the same render, as they do when a card comes back.
  const navigationKeyRef = useRef(navigationKey);
  useLayoutEffect(() => {
    if (navigationKeyRef.current === navigationKey) return;
    navigationKeyRef.current = navigationKey;
    if (initialGroupIndex !== currentGroupIndex) pendingItemIndexRef.current = initialItemIndex;
    else if (scrollContainerRef?.current) scrollContainerRef.current.scrollTop = 0;
    setCurrentGroupIndex(initialGroupIndex);
    setCurrentItemIndex(initialItemIndex);
  }, [navigationKey, initialGroupIndex, initialItemIndex, currentGroupIndex, scrollContainerRef]);

  return {
    currentGroupIndex, setCurrentGroupIndex, currentItemIndex, setCurrentItemIndex,
    safeGroupIndex, currentGroup, currentItem, hasNextGroup, hasPrevGroup, hasPrevItem,
  };
}

/**
 * Puts the card's pages back at their tops when another card takes the slot on screen without a move, as when a
 * delete or archive slides the next card into place. `cardKey` names what fills the slot: a word card's group
 * title, so moving between its meanings keeps the place, or the listed sentence's id in sentence review, so a
 * preview binding to its saved copy keeps it too. A move between cards resets the pages already (above).
 */
export function useScrollTopOnNewCard(
  cardKey: string | undefined,
  { scrollContainerRef, sentenceReview }: Pick<CardNavigationOptions, 'scrollContainerRef' | 'sentenceReview'>,
) {
  const prevCardKeyRef = useRef(cardKey);
  useLayoutEffect(() => {
    if (prevCardKeyRef.current === cardKey) return;
    prevCardKeyRef.current = cardKey;
    if (scrollContainerRef?.current) scrollContainerRef.current.scrollTop = 0;
    if (sentenceReview) {
      const analysisScroller = document.querySelector<HTMLElement>('[data-sentence-analysis]');
      if (analysisScroller) analysisScroller.scrollTop = 0;
    }
  }, [cardKey, scrollContainerRef, sentenceReview]);
}
