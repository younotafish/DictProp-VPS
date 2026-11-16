import { useCallback, useEffect, useMemo, useState } from 'react';
import { isVocabItem, savedVocabKey, type SentenceData, type StoredItem, type VocabCard } from '../types';
import { normalizeSentenceIdentity, sameSentenceText } from '../services/sentenceIdentity';
import { sameItemContent } from '../services/items';
import { buildVariantIndex, matchBaseWords } from '../services/wordMatch';
import { buildSavedVocabByBase, pickSavedItem, savedCardsForBases } from '../services/notebook/libraryLookups';
import { catalogProgressKind, type CatalogKind } from '../services/catalogProgressIdentity';
import { useStableArray } from './useStableValue';

// Words and phrases still in the library, archived or not. Sentences have their own lists.
export const isActiveLibraryItem = (item: StoredItem): boolean => !item.isDeleted && item.type !== 'sentence';

/** The lists the screens show, derived from the library, and the lookups that tell what's saved. */
export function useLibraryViews(savedItems: StoredItem[]) {
  // Derived state - memoized filtered items. Reviewing a sentence replaces the library array but no word,
  // so the stable copies keep the notebook, the study queue and the open card from rebuilding.
  const filteredActiveItems = useMemo(() => savedItems.filter(isActiveLibraryItem), [savedItems]);
  const allActiveItems = useStableArray(filteredActiveItems);
  // The lookup indexes read only item content. A review replaces an item's wrapper but keeps its data,
  // so they key on this content snapshot and skip the rebuild each review would otherwise cost.
  const activeContent = useStableArray(allActiveItems, sameItemContent);
  // Variant-aware lookup index (base word + each inflected form → base word), rebuilt
  // only when content changes. Powers "search a variant → pop up the saved card, skip AI".
  const variantIndex = useMemo(() => buildVariantIndex(activeContent), [activeContent]);
  // base word → its most useful saved vocab item, so footnote lookup is O(1) per word
  // instead of an O(n) scan over the whole library on every rendered token. See findSavedItem.
  // The review-count tie-break reads the snapshot's counts, which is close enough for a tie-break.
  const savedVocabByBase = useMemo(() => buildSavedVocabByBase(activeContent), [activeContent]);
  // Items available for study (excludes archived and sentences)
  const filteredStudyItems = useMemo(() => savedItems.filter(i => !i.isDeleted && !i.isArchived && i.type !== 'sentence'), [savedItems]);
  const studyItems = useStableArray(filteredStudyItems);
  // Ordinary saved sentences, Real Life collections, and Essays deliberately use separate queues.
  // Catalog records have stable namespaced ids, so reviewing one context never changes another
  // context's score or the Sentences tab's due count.
  // Reviewing a word replaces the library array but no sentence, so the stable copy keeps the sentence
  // lists below, and the screens they feed, from rebuilding.
  const filteredSentenceItems = useMemo(
    () => savedItems.filter(i => !i.isDeleted && i.type === 'sentence'),
    [savedItems],
  );
  const allSentenceItems = useStableArray(filteredSentenceItems);
  // One pass sorts them into the three queues, each in library order. A queue keeps its array while none of its own
  // records changes, so a review in one catalog doesn't hand the other catalog's tab or the Sentences list a new one.
  const sentenceQueues = useMemo(() => {
    const queues: Record<CatalogKind | 'saved', StoredItem[]> = { 'real-life': [], essay: [], saved: [] };
    for (const item of allSentenceItems) queues[catalogProgressKind(item) ?? 'saved'].push(item);
    return queues;
  }, [allSentenceItems]);
  const realLifeProgressItems = useStableArray(sentenceQueues['real-life']);
  const essayProgressItems = useStableArray(sentenceQueues.essay);
  const sentenceItems = useStableArray(sentenceQueues.saved);
  const sentenceItemsById = useMemo(
    () => new Map(allSentenceItems.map(item => [item.data.id, item])),
    [allSentenceItems],
  );
  // The badge counts the sentences due now, so it counts again when the next one falls due, and when the
  // page comes back after sleeping through some. The clock only says when; the count reads the time itself.
  const [sentenceDueClock, setSentenceDueClock] = useState(0);
  const sentenceDueCount = useMemo(() => {
    const now = Date.now();
    return sentenceItems.filter(s => !s.isArchived && ((s.srs?.nextReview ?? 0) <= now)).length;
  }, [sentenceItems, sentenceDueClock]);
  useEffect(() => {
    const now = Date.now();
    let nextDue = Infinity;
    for (const s of sentenceItems) {
      const due = s.srs?.nextReview ?? 0;
      if (!s.isArchived && due > now && due < nextDue) nextDue = due;
    }
    const recount = () => setSentenceDueClock(Date.now());
    const onVisible = () => { if (document.visibilityState === 'visible') recount(); };
    document.addEventListener('visibilitychange', onVisible);
    // A timer holds at most 2^31 - 1 ms (about 24.8 days); a later one just counts again then.
    const timer = nextDue === Infinity ? undefined : window.setTimeout(recount, Math.min(nextDue - now + 50, 2 ** 31 - 1));
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(timer);
    };
  }, [sentenceItems, sentenceDueClock]);

  // Both checks run once per rendered sentence or search result, so they look up prebuilt sets, which reviews and
  // listens don't rebuild: the sentence set reads only the sentences' texts (an enrichment that leaves a text alone
  // keeps it too), and the vocab set only the words' content.
  const sentenceContent = useStableArray(sentenceItems, sameSentenceText);
  const savedSentenceIdentities = useMemo(
    () => new Set(sentenceContent.map(s => normalizeSentenceIdentity((s.data as SentenceData).text))),
    [sentenceContent],
  );
  const isSentenceSaved = useCallback((text: string) => {
    const identity = normalizeSentenceIdentity(text);
    return !!identity && savedSentenceIdentities.has(identity);
  }, [savedSentenceIdentities]);

  const savedVocabKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of activeContent) if (isVocabItem(item)) keys.add(savedVocabKey(item.data));
    return keys;
  }, [activeContent]);
  const isVocabSaved = useCallback(
    (vocab: VocabCard) => savedVocabKeys.has(savedVocabKey(vocab)),
    [savedVocabKeys],
  );

  // Global lookup across the whole notebook so searching a saved word
  // — OR any inflected variant of it (running→run, cats→cat, happier→happy) — pops up the
  // existing card instead of re-running an AI search. Variant matching is via variantIndex
  // (forms + conservative lemmatiser; see services/wordMatch). isVocabSaved stays exact.
  const findSavedByWord = useCallback((word: string): VocabCard[] => {
    const bases = matchBaseWords(word, variantIndex);
    if (bases.size === 0) return [];
    return savedCardsForBases(bases, activeContent);
  }, [activeContent, variantIndex]);

  // Footnote lookup: the saved item (vocab or phrase) a sentence term maps to, or null. Variant-aware
  // for vocab (running→run etc.) via variantIndex; exact normalized match for phrases. Picks the
  // most useful modern-American sense, using review count only as a tie-breaker.
  const findSavedItem = useCallback((term: string): StoredItem | null => {
    const bases = matchBaseWords(term, variantIndex);
    if (bases.size === 0) return null;
    // O(candidates) via the prebuilt index — NOT an O(n) scan per token (this runs per word in every
    // rendered sentence). Vocab only; multi-word vocab still matches via variantKeys.
    return pickSavedItem(bases, savedVocabByBase);
  }, [variantIndex, savedVocabByBase]);

  // The saved base words a query is a variant of (ran -> run): the notebook's search lists their cards with its matches.
  const matchSavedBases = useCallback((q: string) => matchBaseWords(q, variantIndex), [variantIndex]);
  // Cheap boolean variant check (no card collection). Nothing reads it since the notebook's 'notebook-search'
  // listener went; App still passes it to the notebook until that prop is dropped (handoff).
  const hasSavedVariant = useCallback((q: string) => matchSavedBases(q).size > 0, [matchSavedBases]);

  return {
    allActiveItems, studyItems, allSentenceItems, realLifeProgressItems, essayProgressItems, sentenceItems, sentenceItemsById,
    sentenceDueCount, isSentenceSaved, isVocabSaved, findSavedByWord, findSavedItem, matchSavedBases, hasSavedVariant,
  };
}

export type LibraryViews = ReturnType<typeof useLibraryViews>;
