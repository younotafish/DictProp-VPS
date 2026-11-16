import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ItemGroup } from '../../types';
import { useStableArray } from '../../hooks/useStableValue';

type CardNavigationOptions = {
  initialGroupIndex: number;
  initialItemIndex: number;
  /** A new value moves the view to initialGroupIndex/initialItemIndex (see DetailViewProps). */
  navigationKey: number | undefined;
  /**
   * The card's scroller, put back at its top whenever another card shows: after a move to another word, or when a
   * delete or archive slides the next card into place. Moving between a word's meanings keeps the place. Sentence
   * review passes its sentence page's scroller.
   */
  scrollContainerRef: RefObject<HTMLElement | null>;
} & (
  /** The word card, which follows the card on screen by the card's id. */
  | { sentenceReview: false }
  /**
   * Sentence review keeps its analysis page open between sentences, scrolled back to the top. Its groups are the
   * sentences' source cards, which repeat, so it follows the sentence on screen by `sentenceIds`, one per group.
   */
  | { sentenceReview: true; sentenceIds: readonly string[] }
);

/** Where the view is: a group, and a card in it. */
export interface CardPlace {
  groupIndex: number;
  itemIndex: number;
}

/** Each group's card ids, or in sentence review each group's sentence id: what the view follows. */
export type CardKeys = readonly (readonly string[])[];

/** The cards the view last followed, where it followed the card on screen to, and whether another card took its place. */
interface Followed {
  keys: CardKeys;
  groupIndex: number;
  replaced: boolean;
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * Where the view is in its cards: a group (one word, or one sentence in sentence review) and a card inside it
 * (one meaning). The indices start from the caller's. When a delete, an archive or an undo changes the cards, they
 * follow the card on screen (followShownCard), and what's shown is clamped in case the caller's outran the groups.
 */
export function useCardNavigation(groups: ItemGroup[], options: CardNavigationOptions) {
  const { initialGroupIndex, initialItemIndex, navigationKey, scrollContainerRef, sentenceReview } = options;
  const sentenceIds = options.sentenceReview ? options.sentenceIds : undefined;
  const [currentGroupIndex, setCurrentGroupIndex] = useState(initialGroupIndex);
  const [currentItemIndex, setCurrentItemIndex] = useState(initialItemIndex);

  // The cards by key, kept while only their contents change (a review, a sync), so following them costs nothing then.
  const freshKeys = useMemo(
    () => sentenceIds ? sentenceIds.map(id => [id]) : groups.map(group => group.items.map(item => item.data.id)),
    [groups, sentenceIds],
  );
  const keys = useStableArray<readonly string[]>(freshKeys, sameKeys);

  // When the cards change, the indices move to the card on screen during this render, so no other card is ever shown
  // in its place, not even for a frame that the screen never paints but the view's effects would act on.
  const [followed, setFollowed] = useState<Followed>(() => ({ keys, groupIndex: initialGroupIndex, replaced: false }));
  if (followed.keys !== keys) {
    const place = followShownCard(followed.keys, keys, { groupIndex: currentGroupIndex, itemIndex: currentItemIndex });
    setFollowed({ keys, groupIndex: place.groupIndex, replaced: place.replaced });
    if (place.groupIndex !== currentGroupIndex) setCurrentGroupIndex(place.groupIndex);
    if (place.itemIndex !== currentItemIndex) setCurrentItemIndex(place.itemIndex);
  }

  // Determine current item to display, clamped in case the caller's indices outran the groups.
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

  // Reset item index and scroll when user navigates to a different group (not when following the card on screen).
  // Every way of moving between words lands here, and the layout effect paints the new one from its top. The resets
  // are skipped when already in place: setting a state to its current value right after a render still runs this
  // whole component again.
  const prevGroupIndexRef = useRef(currentGroupIndex);
  // A move to a given card (navigationKey, below) lands on that card's sense rather than the first.
  const pendingItemIndexRef = useRef<number | null>(null);
  const seenFollowedRef = useRef(followed);
  useLayoutEffect(() => {
    if (seenFollowedRef.current !== followed) {
      // The indices followed the card on screen, which is no move. A card that took the place of one that left, as
      // when a delete or archive slides the next card in, opens at its top.
      seenFollowedRef.current = followed;
      prevGroupIndexRef.current = followed.groupIndex;
      if (followed.replaced && scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    }
    if (prevGroupIndexRef.current !== currentGroupIndex) {
      prevGroupIndexRef.current = currentGroupIndex;
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
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
  }, [followed, currentGroupIndex, sentenceReview, currentItemIndex, scrollContainerRef]);

  // The caller moves the view by changing navigationKey. Declared after the two effects above, so its indices win
  // when the groups change in the same render, as they do when an undo puts a card back and the view moves to it.
  const navigationKeyRef = useRef(navigationKey);
  useLayoutEffect(() => {
    if (navigationKeyRef.current === navigationKey) return;
    navigationKeyRef.current = navigationKey;
    if (initialGroupIndex !== currentGroupIndex) pendingItemIndexRef.current = initialItemIndex;
    else if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setCurrentGroupIndex(initialGroupIndex);
    setCurrentItemIndex(initialItemIndex);
  }, [navigationKey, initialGroupIndex, initialItemIndex, currentGroupIndex, scrollContainerRef]);

  return {
    currentGroupIndex, setCurrentGroupIndex, currentItemIndex, setCurrentItemIndex, currentGroup, currentItem,
    hasNextGroup, hasPrevGroup, hasPrevItem,
  };
}

const clampIndex = (index: number, length: number): number => Math.max(0, Math.min(index, length - 1));

/**
 * Where the view goes when its cards change under it, as when a delete or archive (here or on another device) takes
 * some out or an undo puts one back: to the card it showed, wherever that card is now. Only when that card left does
 * another take its place, and `replaced` says so: the next meaning of its word, or the one before when it was the
 * last; or, when the whole word left, the first meaning of the next word, or of the word before after the last word.
 * `at` is where the view was among `before`, clamped as it was shown.
 */
export function followShownCard(before: CardKeys, after: CardKeys, at: CardPlace): CardPlace & { replaced: boolean } {
  const places = new Map<string, CardPlace>();
  after.forEach((keys, groupIndex) => keys.forEach((key, itemIndex) => {
    if (!places.has(key)) places.set(key, { groupIndex, itemIndex });
  }));
  const firstPlace = (keys: readonly string[]): CardPlace | undefined => {
    for (const key of keys) {
      const place = places.get(key);
      if (place) return place;
    }
    return undefined;
  };

  const groupIndex = clampIndex(at.groupIndex, before.length);
  const group = before[groupIndex] ?? [];
  const itemIndex = clampIndex(at.itemIndex, group.length);
  const kept = group.length > 0 ? places.get(group[itemIndex]) : undefined;
  if (kept) return { ...kept, replaced: false };

  const meaning = firstPlace(group.slice(itemIndex + 1)) ?? firstPlace(group.slice(0, itemIndex).reverse());
  if (meaning) return { ...meaning, replaced: true };

  let word: CardPlace | undefined;
  for (let index = groupIndex + 1; index < before.length && !word; index++) word = firstPlace(before[index]);
  for (let index = groupIndex - 1; index >= 0 && !word; index--) word = firstPlace(before[index]);
  return { groupIndex: word?.groupIndex ?? 0, itemIndex: 0, replaced: true };
}
