import { useCallback, useMemo, useRef, useState } from 'react';
import { getItemTitle, isSentenceItem, type ItemGroup, type SentenceData, type StoredItem } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { sentenceSourceResolver, syntheticSourceItem } from '../services/sentenceSource';
import { normalizeSentenceIdentity } from '../services/sentenceIdentity';
import { isCatalogProgressItem } from '../services/catalogProgressIdentity';
import { useStableArray } from './useStableValue';
import type { Library } from './useLibrary';
import type { LibraryViews } from './useLibraryViews';
import type { UndoOffer } from './useUndoOffer';

export interface DetailContext {
  groups: ItemGroup[];
  groupIndex: number;
  itemIndex: number;
  sentenceItems?: StoredItem[];
  /** New on each opening, so cards opened over open ones start a fresh view. */
  openId: number;
  /** Changes when the open view should move to groupIndex/itemIndex (DetailView's navigationKey). */
  navigationKey?: number;
}
let detailKeyCount = 0;
/** A fresh key for DetailContext's openId or navigationKey. */
export const nextDetailKey = (): number => ++detailKeyCount;

/** Where the item `id` sits in `context`: sentences in sentence mode, cards otherwise. */
export const findInDetailContext = (context: DetailContext, id: string): { groupIndex: number; itemIndex: number } | null => {
  if (context.sentenceItems) {
    const groupIndex = context.sentenceItems.findIndex(item => item.data.id === id);
    return groupIndex < 0 ? null : { groupIndex, itemIndex: 0 };
  }
  for (let groupIndex = 0; groupIndex < context.groups.length; groupIndex++) {
    const itemIndex = context.groups[groupIndex].items.findIndex(item => item.data.id === id);
    if (itemIndex >= 0) return { groupIndex, itemIndex };
  }
  return null;
};

/**
 * `context` without the card `id`, or `context` itself when the card isn't in it; null when it was the last card.
 * Sentence review is left to withoutSentence, since its groups hold source cards rather than the sentences.
 * groupIndex and itemIndex stay in range: they're where the view opens, and an open view reads them again only
 * when navigationKey changes.
 */
export const withoutCard = (context: DetailContext, id: string): DetailContext | null => {
  if (context.sentenceItems) return context; // sentence mode → withoutSentence handles it
  if (!context.groups.some(group => group.items.some(item => item.data.id === id))) return context;

  const newGroups = context.groups.map(group => ({
    ...group,
    items: group.items.filter(item => item.data.id !== id)
  })).filter(group => group.items.length > 0);

  if (newGroups.length === 0) return null;

  const newGroupIndex = Math.min(context.groupIndex, newGroups.length - 1);
  let newItemIndex = Math.min(context.itemIndex, newGroups[newGroupIndex].items.length - 1);
  newItemIndex = Math.max(0, newItemIndex);

  return { ...context, groups: newGroups, groupIndex: newGroupIndex, itemIndex: newItemIndex };
};

/**
 * Sentence review without the sentence `sentenceId` and its aligned group, keeping `groups` and `sentenceItems`
 * in lockstep; null when it was the last sentence. Anything else comes back as it was.
 */
export const withoutSentence = (context: DetailContext, sentenceId: string): DetailContext | null => {
  if (!context.sentenceItems) return context;
  const idx = context.sentenceItems.findIndex(s => s.data.id === sentenceId);
  if (idx === -1) return context;
  const newSentenceItems = context.sentenceItems.filter((_, i) => i !== idx);
  const newGroups = context.groups.filter((_, i) => i !== idx);
  if (newSentenceItems.length === 0) return null; // reviewed/deleted the last one → close
  const newGroupIndex = Math.min(context.groupIndex, newGroups.length - 1);
  return { ...context, groups: newGroups, sentenceItems: newSentenceItems, groupIndex: newGroupIndex, itemIndex: 0 };
};

const NO_GROUPS: ItemGroup[] = [];
const sameGroupItems = (a: ItemGroup, b: ItemGroup): boolean => a === b ||
  (a.title === b.title && a.items.length === b.items.length && a.items.every((item, index) => item === b.items[index]));

/** The open card view: the cards in it, kept live with the library, and the ways it opens and loses cards. */
export function useDetailView(
  { allActiveItems, sentenceItemsById }: Pick<LibraryViews, 'allActiveItems' | 'sentenceItemsById'>,
  { latestItemsRef }: Pick<Library, 'latestItemsRef'>,
) {
  // Updated DetailContext to support Group-based navigation (2D: Groups vs Items)
  // NOTE: We no longer restore detailContext from localStorage. Persisted groups
  // can contain stale/corrupted StoredItem data that crashes DetailView on reload.
  // The trade-off is minor: users return to the notebook after a reload instead of
  // resuming exactly where they were in the detail view.
  // `sentenceItems` (when present) puts DetailView in "sentence mode": it is aligned 1:1 with
  // `groups` — groups[i] is the resolved source card for the saved sentence sentenceItems[i].
  // Every change goes through updateDetailContext, which keeps the ref current and counts the changes: an
  // undo puts a card back into the view only while nothing else has changed the view.
  const [detailContext, setDetailContext] = useState<DetailContext | null>(null);
  const detailContextRef = useRef<DetailContext | null>(null);
  const detailVersionRef = useRef(0);
  const updateDetailContext = useCallback((next: DetailContext | null | ((prev: DetailContext | null) => DetailContext | null)) => {
    const value = typeof next === 'function' ? next(detailContextRef.current) : next;
    if (value === detailContextRef.current) return;
    detailContextRef.current = value;
    detailVersionRef.current += 1;
    setDetailContext(value);
  }, []);

  const liveDetailSentenceItems = useMemo(
    () => detailContext?.sentenceItems?.map(snapshot => sentenceItemsById.get(snapshot.data.id) ?? snapshot),
    [detailContext?.sentenceItems, sentenceItemsById],
  );
  // The open cards follow the library too: a sync or an edit made elsewhere shows at once, and an edit made
  // on a card builds on its current copy rather than the one the view opened with.
  const detailGroupIds = useMemo(
    () => new Set(detailContext?.groups.flatMap(group => group.items.map(item => item.data.id))),
    [detailContext?.groups],
  );
  const resolvedDetailGroups = useMemo(() => {
    const groups = detailContext?.groups;
    if (!groups?.length) return NO_GROUPS;
    const live = new Map<string, StoredItem>();
    for (const item of allActiveItems) if (detailGroupIds.has(item.data.id)) live.set(item.data.id, item);
    return groups.map(group => {
      const items = group.items.map(item => live.get(item.data.id) ?? item);
      return items.every((item, index) => item === group.items[index]) ? group : { ...group, items };
    });
  }, [detailContext?.groups, detailGroupIds, allActiveItems]);
  // A change to a card that isn't open leaves them as they were, so the view's autoplay keeps its beat.
  const liveDetailGroups = useStableArray(resolvedDetailGroups, sameGroupItems);
  const closeDetail = useCallback(() => updateDetailContext(null), [updateDetailContext]);

  // Remove a card from the open view (see withoutCard).
  const removeItemFromDetailContext = useCallback((id: string) => {
    updateDetailContext(prev => prev && withoutCard(prev, id));
  }, [updateDetailContext]);

  // Sentence-mode counterpart: a sentence's group is keyed by its source-word card id, so the
  // sentence's own id never matches in removeItemFromDetailContext (see withoutSentence).
  const removeSentenceFromDetailContext = useCallback((sentenceId: string) => {
    updateDetailContext(prev => prev && withoutSentence(prev, sentenceId));
  }, [updateDetailContext]);

  // Runs `remove` on the open card view and, if that changed it, returns the view as it was for the undo.
  const removeFromDetailView = useCallback((remove: () => void): UndoOffer['view'] => {
    const before = detailContextRef.current;
    const version = detailVersionRef.current;
    remove();
    return before && detailVersionRef.current !== version ? { before, version: detailVersionRef.current } : undefined;
  }, []);

  // Updated handler to support groups
  const handleViewStoredItem = useCallback((groups: ItemGroup[], groupIndex: number, itemIndex: number) => {
      updateDetailContext({ groups, groupIndex, itemIndex, openId: nextDetailKey() });
  }, [updateDetailContext]);

  // Open a saved sentence's source card in DetailView (sentence mode). `ordered` is the on-screen
  // (due-first) order from SentencesView, so swipe/arrow order matches the list exactly. Each sentence
  // maps to one group whose single item is its resolved source vocab card — matched by word + sense
  // across the whole notebook, then by a form a card lists (services/sentenceSource), falling back to a
  // synthetic minimal card (showing the sentence as its sole example) when the source word no longer exists.
  const handleViewSentence = useCallback((ordered: StoredItem[], index: number) => {
    if (ordered.length === 0) return;
    const findSource = sentenceSourceResolver(latestItemsRef.current);
    const groups: ItemGroup[] = ordered.map(s => {
      const d = s.data as SentenceData;
      const resolved = findSource(d.sourceWord, d.sourceSense) ?? syntheticSourceItem(d.id, d.sourceWord, d.sourceSense, d.text);
      return { title: getItemTitle(resolved), items: [resolved] };
    });
    const safeIndex = Math.min(Math.max(0, index), groups.length - 1);
    updateDetailContext({ groups, groupIndex: safeIndex, itemIndex: 0, sentenceItems: ordered, openId: nextDetailKey() });
  }, [updateDetailContext, latestItemsRef]);

  // Resolve an example to a sentence card without changing the notebook: its saved copy when there is one (a
  // catalog sentence's progress record never counts), else a preview under a temporary id. The card view fetches
  // the prepared analysis and picture itself (useSentenceEnrichment), so the example opens at once.
  const prepareExampleSentence = useCallback((text: string, sourceWord: string, sourceSense?: string): StoredItem | null => {
    const identity = normalizeSentenceIdentity(text);
    if (!identity) return null;

    const existing = latestItemsRef.current.find(item =>
      !item.isDeleted && isSentenceItem(item) && !isCatalogProgressItem(item) &&
      normalizeSentenceIdentity((item.data as SentenceData).text) === identity
    );
    if (existing) return existing;

    const id = `sentence-preview:${crypto.randomUUID()}`;
    return {
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(id, 'sentence'),
      data: { id, text, sourceWord, sourceSense },
    };
  }, [latestItemsRef]);

  const handleOpenStudyExample = useCallback((text: string, sourceWord: string, sourceSense?: string) => {
    const sentence = prepareExampleSentence(text, sourceWord, sourceSense);
    if (sentence) handleViewSentence([sentence], 0);
  }, [handleViewSentence, prepareExampleSentence]);

  return {
    detailContext, detailVersionRef, updateDetailContext, liveDetailGroups, liveDetailSentenceItems, closeDetail,
    removeItemFromDetailContext, removeSentenceFromDetailContext, removeFromDetailView,
    handleViewStoredItem, handleViewSentence, prepareExampleSentence, handleOpenStudyExample,
  };
}

export type DetailViewState = ReturnType<typeof useDetailView>;
