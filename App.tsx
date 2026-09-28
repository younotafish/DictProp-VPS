import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { StoredItem, RevisionCursor, ViewState, SyncStatus, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, VocabCard, SearchResult, SentenceData, ItemGroup, isPhraseItem, isVocabItem, isSentenceItem, savedVocabKey, StoredComparison, ComparisonResult, comparisonKey, ReviewEvent, type ReviewRating, type ReviewTaskType } from './types';
import { Loader2, X } from 'lucide-react';
import { loadData, saveData, saveItemUpdates, deleteItemRecords, storeMissingItemHashes, saveImagesBatch, saveImage, getStoredImageIds, getAllStoredImageIds, loadImagesByIds } from './services/storage';
import { mergeDatasets, trackServerContent, applyServerSave, dropExpiredTombstones } from './services/sync';
import { getItemContentHash, isItemDirty } from './services/itemHash';
import { loadAllItems, loadItemChanges, saveItems, loadItemImage, loadItemImagesBatch, analyzeInput, uploadImages, getServerImageManifest, startTtsBackfill, getTtsBackfillStatus, loadComparisons, saveComparisonApi, applyReviewMutation, undoReviewMutation } from './services/api';
import { normalizeSentenceIdentity } from './services/sentenceIdentity';
import { checkAuth, loginRedirect, logout, AuthState } from './services/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { lazyScreen } from './components/lazyScreen';
import { TabScreen } from './components/TabScreen';
import type { DuplicateClusterView } from './components/DuplicatesModal';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { buildVariantIndex, matchBaseWords, normalizeKey, findDuplicateClusters } from './services/wordMatch';
import { AUTH_REQUIRED_EVENT } from './services/http';
import { enqueuePendingReviewMutation, excludePendingReviewItems, overlayPendingReviews, readPendingReviewMutations, removePendingReviewMutation, type PendingReviewMutation } from './services/reviewQueue';
import { useReviewHistory } from './hooks/useReviewHistory';
import { useFrozenWhile, useStableArray } from './hooks/useStableValue';
import { sameItemContent } from './services/items';
import { useGlobalNavigation } from './hooks';
import { log, warn, error as logError } from './services/logger';
import { subscribeToServerMutations } from './services/syncSignals';
import { getUsagePriority, sortStoredSensesByUsage, sortVocabCardsByUsage } from './services/usageAudit';
import { isRealLifeProgressItem } from './services/realLifeProgressIdentity';
import { isEssayProgressItem } from './services/essayProgressIdentity';

// App re-renders on every library change and progress tick, so the screens and overlays are memoized
// and re-render only when their own props change. Their code loads on first use, and the ones a tap can
// open are fetched once the first screen is up (see the preload effect in App).
const NotebookView = lazyScreen('notebook', () => import('./views/Notebook').then(module => ({ default: module.NotebookView })));
const GlobalSearch = lazyScreen('global-search', () => import('./components/GlobalSearch').then(module => ({ default: React.memo(module.GlobalSearch) })));
const ConfirmModal = lazyScreen('confirm-modal', () => import('./components/ConfirmModal').then(module => ({ default: module.ConfirmModal })));
const DuplicatesModal = lazyScreen('duplicates-modal', () => import('./components/DuplicatesModal').then(module => ({ default: module.DuplicatesModal })));
const CardReviewPopup = lazyScreen('card-review-popup', () => import('./components/CardReviewPopup').then(module => ({ default: React.memo(module.CardReviewPopup) })));
const KeyboardHelpModal = lazyScreen('keyboard-help', () => import('./components/KeyboardHelpModal').then(module => ({ default: module.KeyboardHelpModal })));
const StudyEnhanced = lazyScreen('study', () => import('./views/StudyEnhanced').then(module => ({ default: React.memo(module.StudyEnhanced) })));
const AppNavigation = lazyScreen('navigation', () => import('./components/AppNavigation').then(module => ({ default: React.memo(module.default) })));
const SentencesView = lazyScreen('sentences', () => import('./views/SentencesView').then(module => ({ default: React.memo(module.SentencesView) })));
const RealLifeView = lazyScreen('real-life', () => import('./views/RealLifeView').then(module => ({ default: React.memo(module.RealLifeView) })));
const EssaysView = lazyScreen('essays', () => import('./views/EssaysView').then(module => ({ default: React.memo(module.EssaysView) })));
const DetailView = lazyScreen('detail', () => import('./views/DetailView').then(module => ({ default: React.memo(module.DetailView) })));
const TAB_SCREENS = {
  notebook: NotebookView,
  study: StudyEnhanced,
  sentences: SentencesView,
  'real-life': RealLifeView,
  essays: EssaysView,
} satisfies Record<ViewState, { preload: () => void }>;

interface DetailContext {
  groups: ItemGroup[];
  groupIndex: number;
  itemIndex: number;
  sentenceItems?: StoredItem[];
}

// Older builds mirrored the library into localStorage. It never fit, and its stripped copies could
// overwrite full items, so drop them and leave the quota to the synchronous review outbox.
const clearLegacyLibraryCaches = (): void => {
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith('vps_items_cache') || key?.startsWith('popdict_items') || key === 'app_last_hidden') {
        localStorage.removeItem(key);
      }
    }
  } catch { /* storage unavailable */ }
};

// Words and phrases still in the library, archived or not. Sentences have their own lists.
const isActiveLibraryItem = (item: StoredItem): boolean => !item.isDeleted && item.type !== 'sentence';

const offloadImages = async (images: Array<{ id: string; base64: string }>): Promise<void> => {
  const { offloadAndUpload } = await import('./services/imagePipeline');
  await offloadAndUpload(images);
};

// Merge variant-duplicate clusters (Phase 2 of the dedup tool). For each merge, every
// live vocab card whose word is a variant in the cluster is relabeled to the canonical
// headword and given the UNION of all members' forms (plus the original variant spellings,
// so future searches still resolve). Cards that collide on the same sense after relabel are
// deduped — the richer / more-reviewed one survives and the rest are soft-deleted. Pure and
// deterministic; returns a new array while preserving unchanged references.
function applyMerges(
  items: StoredItem[],
  merges: Array<{ baseWords: string[]; canonical: string }>
): StoredItem[] {
  if (!merges || merges.length === 0) return items;
  const now = Date.now();
  const result = items.slice();

  const scoreCard = (it: StoredItem): number => {
    const reviews = it.srs?.totalReviews || 0;
    const c = it.data as VocabCard;
    const richness =
      (c.definition?.length || 0) +
      (Array.isArray(c.examples) ? c.examples.length : 0) * 50 +
      (c.history?.length || 0) +
      (c.imageUrl ? 1000 : 0);
    return reviews * 100000 + richness;
  };

  for (const { baseWords, canonical } of merges) {
    const canon = normalizeKey(canonical);
    if (!canon) continue;
    const baseSet = new Set(baseWords.map(b => normalizeKey(b)));

    const members = result
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) =>
        it.type === 'vocab' && !it.isDeleted &&
        baseSet.has(normalizeKey((it.data as VocabCard).word || ''))
      );
    if (members.length < 2) continue;

    // Display spelling of the canonical headword: reuse an existing card's exact spelling if present.
    let canonDisplay = canonical.trim();
    for (const { it } of members) {
      if (normalizeKey((it.data as VocabCard).word || '') === canon) {
        canonDisplay = ((it.data as VocabCard).word || '').trim();
        break;
      }
    }

    // Union of forms + the original variant spellings (minus the canonical itself).
    const unionForms = new Set<string>();
    for (const { it } of members) {
      const c = it.data as VocabCard;
      if (Array.isArray(c.forms)) for (const f of c.forms) { const t = (f || '').trim(); if (t) unionForms.add(t); }
      const w = (c.word || '').trim();
      if (w && normalizeKey(w) !== canon) unionForms.add(w);
    }
    const mergedForms = [...unionForms].filter(f => normalizeKey(f) !== canon);

    // Dedupe by sense — keep the best card per sense, soft-delete the rest.
    const bestBySense = new Map<string, number>();
    const losers = new Set<number>();
    for (const { it, idx } of members) {
      const senseKey = ((it.data as VocabCard).sense || '').toLowerCase().trim();
      const prevIdx = bestBySense.get(senseKey);
      if (prevIdx === undefined) {
        bestBySense.set(senseKey, idx);
      } else if (scoreCard(result[prevIdx]) >= scoreCard(it)) {
        losers.add(idx);
      } else {
        losers.add(prevIdx);
        bestBySense.set(senseKey, idx);
      }
    }

    for (const { it, idx } of members) {
      if (losers.has(idx)) {
        result[idx] = { ...it, isDeleted: true, updatedAt: now };
      } else {
        const c = it.data as VocabCard;
        result[idx] = { ...it, data: { ...c, word: canonDisplay, forms: mergedForms }, updatedAt: now };
      }
    }
  }

  return result;
}

// Sentinel value replacing base64 in React state — tells OfflineImage to load from IDB
const IMAGE_IDB_MARKER = 'idb:stored';
const SERVER_IMAGE_MARKER = 'server:has_image';

const getServerImageVersion = (url: string | undefined): string | undefined =>
  url?.startsWith(`${SERVER_IMAGE_MARKER}:`)
    ? url.slice(SERVER_IMAGE_MARKER.length + 1)
    : undefined;

// Check if an imageUrl is a marker (not real base64 data)
const isImageMarker = (url: string | undefined): boolean =>
  !!url && (url === IMAGE_IDB_MARKER || url === SERVER_IMAGE_MARKER || url.startsWith(`${SERVER_IMAGE_MARKER}:`));

/**
 * Strip base64 imageUrl fields from items and store them in IDB images store.
 * Versioned server markers stay in state so OfflineImage can invalidate an older IDB entry.
 * Replaces base64 with a tiny marker so layout checks (imageUrl truthy) still work.
 * This keeps ~143MB of image data out of React state.
 */
async function stripAndStoreImages(items: StoredItem[]): Promise<StoredItem[]> {
  const imagesToSave: Array<{ id: string; base64: string }> = [];

  const stripped = items.map(item => {
    let changed = false;
    let data = item.data;

    // Vocab item image
    if (isVocabItem(item)) {
      const vc = data as VocabCard;
      if (vc.imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: data.id, base64: vc.imageUrl });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
        changed = true;
      }
    }

    // Phrase item image + nested vocab images
    if (isPhraseItem(item)) {
      const sr = data as SearchResult;
      if (sr.imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: sr.id, base64: sr.imageUrl });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as SearchResult;
        changed = true;
      }
      if (sr.vocabs?.length) {
        let vocabsChanged = false;
        const newVocabs = sr.vocabs.map(v => {
          if (v.imageUrl?.startsWith('data:image/')) {
            imagesToSave.push({ id: v.id, base64: v.imageUrl });
            vocabsChanged = true;
            return { ...v, imageUrl: IMAGE_IDB_MARKER };
          }
          return v;
        });
        if (vocabsChanged) {
          data = { ...data, vocabs: newVocabs } as SearchResult;
          changed = true;
        }
      }
    }

    return changed ? { ...item, data } : item;
  });

  if (imagesToSave.length > 0) {
    log(`🖼️ Offloading ${imagesToSave.length} images to IDB + server`);
    await offloadImages(imagesToSave);
  }

  return stripped;
}

const DETAIL_CONTEXT_KEY = 'app_detail_context';

const App: React.FC = () => {
  // Auth state
  const [authState, setAuthState] = useState<AuthState>({ user: null, pending: false, loading: true });

  useEffect(() => {
    checkAuth().then(({ user, pending }) => {
      setAuthState({ user, pending, loading: false });
    }).catch(() => {
      setAuthState({ user: null, pending: false, loading: false });
    });
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      void checkAuth().then(({ user, pending }) => {
        setAuthState({ user, pending, loading: false });
      });
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  useEffect(() => {
    void import('./services/audioCache').then(({ requestPersistentStorage }) => requestPersistentStorage());
  }, []);

  const [currentView, setCurrentView] = useState<ViewState>(() => {
    const saved = localStorage.getItem('app_current_view');
    // Default to notebook, and handle legacy 'search' value from old localStorage
    if (!saved || saved === 'search' || !['notebook', 'study', 'sentences', 'real-life', 'essays'].includes(saved)) {
      return 'notebook';
    }
    return saved as ViewState;
  });

  // Fetch screen code ahead of use. A screen whose code isn't in yet shows its fallback for at least 300 ms
  // (React holds a fallback that long once it's shown), so the first screen's code is fetched while the
  // library loads, and the code of everything a tap can open once the first screen is up. That's what lets
  // the app, a card, a tab or a popup appear on the first frame.
  useEffect(() => {
    for (const screen of [TAB_SCREENS[currentView], AppNavigation, GlobalSearch]) screen.preload();
    const preloadRest = () => {
      for (const screen of [DetailView, ...Object.values(TAB_SCREENS), CardReviewPopup, ConfirmModal, DuplicatesModal, KeyboardHelpModal]) {
        screen.preload();
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preloadRest, { timeout: 2_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preloadRest, 1_000);
    return () => window.clearTimeout(timer);
  }, []);

  // Persist current view
  useEffect(() => {
    try { localStorage.setItem('app_current_view', currentView); } catch { /* storage full or unavailable */ }
  }, [currentView]);

  // The library. IndexedDB is the only local copy.
  const [savedItems, setSavedItems] = useState<StoredItem[]>([]);
  // The library as of the latest change, for handlers and async work that outlive a render.
  const latestItemsRef = useRef<StoredItem[]>(savedItems);
  // The server change the library is current to, stored with it; pulls resume after it. Null until a
  // full snapshot establishes one.
  const serverCursorRef = useRef<RevisionCursor | null>(null);

  /**
   * Every library change goes through here. The transform sees the latest items rather than a
   * render's snapshot, and the ref is current before this returns, so the next handler, IndexedDB
   * write or server push sees the change. An update that replaces no item keeps the old array, so
   * derived indexes don't rebuild.
   */
  const updateItems = useCallback((transform: (items: StoredItem[]) => StoredItem[]): StoredItem[] => {
    const current = latestItemsRef.current;
    const next = transform(current);
    if (next === current || (next.length === current.length && next.every((item, index) => item === current[index]))) {
      return current;
    }
    latestItemsRef.current = next;
    setSavedItems(next);
    return next;
  }, []);

  /** Replaces one item by id. Returns the new copy, or undefined when the id isn't in the library. */
  const replaceItem = useCallback((id: string, update: (item: StoredItem) => StoredItem): StoredItem | undefined => {
    let replaced = undefined as StoredItem | undefined;
    updateItems(items => {
      const index = items.findIndex(item => item.data.id === id);
      if (index < 0) return items;
      replaced = update(items[index]);
      const next = items.slice();
      next[index] = replaced;
      return next;
    });
    return replaced;
  }, [updateItems]);

  // User-scoped saveData wrapper — all saves go through this
  const userSaveData = useCallback((items: StoredItem[]) => {
    return saveData(items, authState.user?.id || 'vps');
  }, [authState.user?.id]);

  const initialServerSyncDoneRef = useRef(false);

  const currentUserIdRef = useRef(authState.user?.id || 'vps');
  currentUserIdRef.current = authState.user?.id || 'vps';

  // Pulls and pushes run one at a time: a pull merges only after an earlier push's acknowledgement is
  // recorded, and each push sends the latest copies. Tasks in the lane call pushNow, not pushDirtyItems,
  // which would wait on the lane itself.
  const syncLaneRef = useRef<Promise<unknown>>(Promise.resolve());
  const inSyncLane = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = syncLaneRef.current.then(task, task);
    syncLaneRef.current = run.catch(() => {});
    return run;
  }, []);

  /** Pushes the dirty items (all, or those in `ids`) and records what the server kept. Returns the count. */
  const pushNow = useCallback(async (ids?: ReadonlySet<string>): Promise<number> => {
    const dirty = latestItemsRef.current.filter(item => (!ids || ids.has(item.data.id)) && isItemDirty(item));
    // Items with an unsent review wait for the review outbox, which applies the review atomically.
    const toPush = excludePendingReviewItems(dirty, currentUserIdRef.current);
    if (toPush.length === 0) return 0;
    const result = await saveItems(toPush);
    const next = updateItems(items => applyServerSave(items, toPush, result));
    await saveData(next, currentUserIdRef.current);
    return toPush.length;
  }, [updateItems]);

  const pushDirtyItems = useCallback(
    (ids?: ReadonlySet<string>) => inSyncLane(() => pushNow(ids)),
    [inSyncLane, pushNow],
  );

  // The pulls below run in the sync lane.

  /** Merges server copies and stores the result together with the cursor they bring it up to. */
  const mergeServerItems = useCallback(async (
    remoteItems: StoredItem[],
    cursor: RevisionCursor,
    { complete = false }: { complete?: boolean } = {},
  ): Promise<void> => {
    let droppedIds: string[] = [];
    const merged = updateItems(items => {
      const next = trackServerContent(mergeDatasets(items, remoteItems), remoteItems, { complete });
      if (!complete) return next;
      // A snapshot brings back the expired tombstones the server still keeps.
      const pruned = dropExpiredTombstones(next);
      droppedIds = pruned.droppedIds;
      return pruned.items;
    });
    serverCursorRef.current = cursor;
    await deleteItemRecords(droppedIds, currentUserIdRef.current)
      .catch(error => warn('Expired deletions stay stored until the next launch:', error));
    await saveData(merged, currentUserIdRef.current, cursor);
  }, [updateItems]);

  /**
   * Merges the server changes after `from`. False when the server is behind the cursor: its database
   * was replaced, so only a full snapshot can reconcile.
   */
  const pullChanges = useCallback(async (from: RevisionCursor): Promise<boolean> => {
    let cursor = from;
    const remoteItems: StoredItem[] = [];
    for (;;) {
      const page = await loadItemChanges(cursor);
      if (page.headRevision !== undefined && page.headRevision < from.revision) return false;
      remoteItems.push(...page.items);
      const advanced = page.cursor.revision > cursor.revision ||
        (page.cursor.revision === cursor.revision && page.cursor.id > cursor.id);
      cursor = page.cursor;
      if (!page.hasMore || !advanced) break;
    }
    if (remoteItems.length === 0) return true;
    await mergeServerItems(remoteItems, cursor);
    log(`Server: pulled ${remoteItems.length} changed item(s)`);
    return true;
  }, [mergeServerItems]);

  /** Merges a complete snapshot. Local items the server lacks turn dirty, so they upload. */
  const syncFullSnapshot = useCallback(async (): Promise<void> => {
    const { items: remoteItems, cursor } = await loadAllItems();
    // An empty server isn't authoritative: merging it would re-upload the whole library.
    if (remoteItems.length === 0) {
      serverCursorRef.current = cursor;
      return;
    }
    await mergeServerItems(remoteItems, cursor, { complete: true });
    log(`Server: merged a full snapshot of ${remoteItems.length} items`);
  }, [mergeServerItems]);

  /** Pulls what changed since the stored cursor, or a full snapshot when there is no usable cursor. */
  const syncWithServer = useCallback(async (): Promise<void> => {
    const cursor = serverCursorRef.current;
    if (cursor && await pullChanges(cursor)) return;
    await syncFullSnapshot();
  }, [pullChanges, syncFullSnapshot]);

  // Durable local write first, then an immediate push. A failed push leaves the items dirty, and the
  // debounced save retries them.
  const persistChangedItems = useCallback(async (items: StoredItem[], label: string): Promise<void> => {
    if (items.length === 0) return;
    try {
      await saveItemUpdates(items, currentUserIdRef.current);
    } catch (error) {
      logError(`${label}: failed to save the local update`, error);
    }

    try {
      await pushDirtyItems(new Set(items.map(item => item.data.id)));
    } catch (error) {
      logError(`${label}: immediate server sync failed`, error);
    }
  }, [pushDirtyItems]);

  // ── Word comparisons (persisted server + local, keyed by the word-set) ──────
  // The GENERATION queue lives in GlobalSearch (the bottom-right search queue) so comparisons behave
  // exactly like word searches. App just owns the persisted store + the save/lookup callbacks.
  const [comparisons, setComparisons] = useState<StoredComparison[]>([]);
  const comparisonsRef = useRef<StoredComparison[]>([]);
  useEffect(() => { comparisonsRef.current = comparisons; }, [comparisons]);
  const { reviewEvents, recordReview, removeReview } = useReviewHistory(authState.user?.id);
  const reviewFlushPromiseRef = useRef<Promise<void> | null>(null);

  const reconcileAppliedReview = useCallback(async (serverItems: StoredItem[]) => {
    if (serverItems.length === 0) return;
    const byId = new Map(serverItems.map(item => [item.data.id, item]));
    const nextItems = updateItems(items => items.map(local => {
      const serverItem = byId.get(local.data.id);
      if (!serverItem) return local;
      // The server's schedule is authoritative, since an undo moves it backwards. Its content is too,
      // and may carry another device's edits, unless this device has unsynced edits to push on top.
      const reconciled = isItemDirty(local)
        ? {
            ...local,
            serverRevision: serverItem.serverRevision,
            updatedAt: Math.max(local.updatedAt || 0, serverItem.updatedAt || 0),
          }
        : mergeDatasets([local], [serverItem])[0];
      return { ...reconciled, srs: serverItem.srs, lastSyncedHash: getItemContentHash(serverItem) };
    }));
    await saveItemUpdates(
      nextItems.filter(item => byId.has(item.data.id)),
      currentUserIdRef.current,
    );
  }, [updateItems]);

  const flushPendingReviews = useCallback(async () => {
    const userId = authState.user?.id;
    if (!userId || !navigator.onLine) return;
    if (reviewFlushPromiseRef.current) return reviewFlushPromiseRef.current;
    const runFlush = async () => {
      try {
        for (;;) {
          const mutation = readPendingReviewMutations(userId)[0];
          if (!mutation) break;
          const response = await applyReviewMutation(mutation.event, mutation.itemIds, mutation.seedItem);
          await reconcileAppliedReview(response.items);
          removePendingReviewMutation(userId, mutation.event.id);
        }
      } catch (error) {
        warn('Pending review sync will retry:', error);
      }
    };
    const flush = navigator.locks
      ? navigator.locks.request(`dictprop-review-flush:${userId}`, runFlush)
      : runFlush();
    reviewFlushPromiseRef.current = flush;
    try {
      await flush;
    } finally {
      if (reviewFlushPromiseRef.current === flush) reviewFlushPromiseRef.current = null;
    }
  }, [authState.user?.id, reconcileAppliedReview]);

  const undoSRSReview = useCallback(async (eventId: string): Promise<void> => {
    const userId = authState.user?.id;
    if (!userId) throw new Error('Sign in again before undoing this review.');
    await flushPendingReviews();
    if (readPendingReviewMutations(userId).some(mutation => mutation.event.id === eventId)) {
      throw new Error(navigator.onLine ? 'This review is still syncing. Try undo again.' : 'Reconnect to undo this review.');
    }
    const response = await undoReviewMutation(eventId);
    await reconcileAppliedReview(response.items);
    removeReview(eventId);
  }, [authState.user?.id, flushPendingReviews, reconcileAppliedReview, removeReview]);

  const comparisonsCacheKey = authState.user ? `vps_comparisons_cache_${authState.user.id}` : 'vps_comparisons_cache';

  const persistComparisons = useCallback((list: StoredComparison[]) => {
    setComparisons(list);
    try { localStorage.setItem(comparisonsCacheKey, JSON.stringify(list)); } catch { /* ignore */ }
  }, [comparisonsCacheKey]);

  // Restore from localStorage instantly, then refresh from the server, once auth resolves.
  useEffect(() => {
    if (authState.loading || !authState.user) return;
    try {
      const cached = localStorage.getItem(comparisonsCacheKey);
      if (cached) { const c = JSON.parse(cached); if (Array.isArray(c)) setComparisons(c); }
    } catch { /* ignore */ }
    loadComparisons().then(persistComparisons).catch((e) => warn('Failed to load comparisons:', e));
  }, [authState.loading, authState.user?.id, comparisonsCacheKey, persistComparisons]);

  // A finished comparison from the search queue → save it (state + local cache + server).
  const handleCompareReady = useCallback((words: string[], data: ComparisonResult) => {
    const c: StoredComparison = { key: comparisonKey(words), words, data, updatedAt: Date.now() };
    persistComparisons([...comparisonsRef.current.filter((x) => x.key !== c.key), c]);
    saveComparisonApi(c).catch((e) => warn('Failed to save comparison to server:', e));
  }, [persistComparisons]);


  // Derived state - memoized filtered items
  const allActiveItems = useMemo(() => savedItems.filter(isActiveLibraryItem), [savedItems]);
  // The lookup indexes read only item content. A review replaces an item's wrapper but keeps its data,
  // so they key on this content snapshot and skip the rebuild each review would otherwise cost.
  const activeContent = useStableArray(allActiveItems, sameItemContent);
  // Variant-aware lookup index (base word + each inflected form → base word), rebuilt
  // only when content changes. Powers "search a variant → pop up the saved card, skip AI".
  const variantIndex = useMemo(() => buildVariantIndex(activeContent), [activeContent]);
  // base word → its most useful saved vocab item, so footnote lookup is O(1) per word
  // instead of an O(n) scan over the whole library on every rendered token. See findSavedItem.
  // The review-count tie-break reads the snapshot's counts, which is close enough for a tie-break.
  const savedVocabByBase = useMemo(() => {
    const m = new Map<string, StoredItem>();
    for (const i of activeContent) {
      if (i.type !== 'vocab') continue;
      const base = normalizeKey((i.data as VocabCard).word || '');
      if (!base) continue;
      const prev = m.get(base);
      const candidatePriority = getUsagePriority((i.data as VocabCard).usageAudit?.status);
      const previousPriority = prev
        ? getUsagePriority((prev.data as VocabCard).usageAudit?.status)
        : Number.POSITIVE_INFINITY;
      if (!prev || candidatePriority < previousPriority ||
          (candidatePriority === previousPriority && (i.srs?.totalReviews ?? 0) > (prev.srs?.totalReviews ?? 0))) {
        m.set(base, i);
      }
    }
    return m;
  }, [activeContent]);
  // Items available for study (excludes archived and sentences)
  const studyItems = useMemo(() => savedItems.filter(i => !i.isDeleted && !i.isArchived && i.type !== 'sentence'), [savedItems]);
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
  const realLifeProgressItems = useMemo(
    () => allSentenceItems.filter(isRealLifeProgressItem),
    [allSentenceItems],
  );
  const essayProgressItems = useMemo(
    () => allSentenceItems.filter(isEssayProgressItem),
    [allSentenceItems],
  );
  const sentenceItems = useMemo(
    () => allSentenceItems.filter(item => !isRealLifeProgressItem(item) && !isEssayProgressItem(item)),
    [allSentenceItems],
  );
  const sentenceItemsById = useMemo(
    () => new Map(allSentenceItems.map(item => [item.data.id, item])),
    [allSentenceItems],
  );
  const sentenceDueCount = useMemo(() => {
    const now = Date.now();
    return sentenceItems.filter(s => !s.isArchived && ((s.srs?.nextReview ?? 0) <= now)).length;
  }, [sentenceItems]);
  
  // Becomes true once IndexedDB has been read (or failed), whether or not it held any items.
  const [isLoaded, setIsLoaded] = useState(false);
  const showNavRef = useRef(true);
  const navRef = useRef<HTMLElement>(null);
  // Per scroller: tabs keep their scroll positions, so one tab's position says nothing about another's.
  const lastScrollYs = useRef(new WeakMap<Element, number>());
  
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [imagePrefetchProgress, setImagePrefetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [imageRestoreProgress, setImageRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  const prefetchAbortRef = useRef(false);

  // Auth is required — app gates on authState below

  // Updated DetailContext to support Group-based navigation (2D: Groups vs Items)
  // NOTE: We no longer restore detailContext from localStorage. Persisted groups
  // can contain stale/corrupted StoredItem data that crashes DetailView on reload.
  // The trade-off is minor: users return to the notebook after a reload instead of
  // resuming exactly where they were in the detail view.
  // `sentenceItems` (when present) puts DetailView in "sentence mode": it is aligned 1:1 with
  // `groups` — groups[i] is the resolved source card for the saved sentence sentenceItems[i].
  const [detailContext, setDetailContext] = useState<DetailContext | null>(null);
  const liveDetailSentenceItems = useMemo(
    () => detailContext?.sentenceItems?.map(snapshot => sentenceItemsById.get(snapshot.data.id) ?? snapshot),
    [detailContext?.sentenceItems, sentenceItemsById],
  );

  // Footnote card popup — keyed by the word's SPELLING (so deleting one sense doesn't lose the rest)
  // plus the sense to open on. popupItems = every saved sense of that word, for in-popup paging; it's
  // re-resolved live from allActiveItems so Got it / Reset / Delete update the card in place.
  const [cardPopup, setCardPopup] = useState<{ spelling: string; initialId: string } | null>(null);
  const openCardPopup = useCallback((it: StoredItem) => setCardPopup({ spelling: getItemSpelling(it), initialId: it.data.id }), []);
  const popupItems = useMemo(
    () => (cardPopup
      ? sortStoredSensesByUsage(allActiveItems.filter(i => i.type === 'vocab' && getItemSpelling(i) === cardPopup.spelling))
      : []),
    [cardPopup, allActiveItems],
  );
  // The notebook sits under DetailView and the card popup, so it skips the reviews made there and
  // catches up once uncovered.
  const notebookItems = useFrozenWhile(allActiveItems, !!detailContext || !!cardPopup);
  const closeDetail = useCallback(() => setDetailContext(null), []);
  const closeCardPopup = useCallback(() => setCardPopup(null), []);
  const notebookUser = useMemo(() => {
    const user = authState.user;
    return user ? { uid: user.id, displayName: user.displayName, photoURL: user.photoUrl, email: user.email } : null;
  }, [authState.user]);
  // Footnote popup: fetch a word's full set of AI senses (cached per session) so the popup can page
  // through saved + not-yet-saved meanings; and save a chosen sense.
  const senseCacheRef = useRef<Map<string, VocabCard[]>>(new Map());
  const fetchSensesForWord = useCallback(async (word: string): Promise<VocabCard[]> => {
    const key = normalizeKey(word);
    if (!key) return [];
    const cached = senseCacheRef.current.get(key);
    if (cached) return cached;
    try {
      const r = await analyzeInput(word);
      const vocabs = Array.isArray(r?.vocabs) ? (r.vocabs as VocabCard[]) : [];
      senseCacheRef.current.set(key, vocabs);
      return vocabs;
    } catch { return []; }
  }, []);
  const saveVocabSense = useCallback((vocab: VocabCard) => {
    const v: VocabCard = { ...vocab, id: vocab.id || crypto.randomUUID() };
    handleSaveRef.current({ data: v, type: 'vocab', savedAt: Date.now(), srs: SRSAlgorithm.createNew(v.id, 'vocab') });
  }, []);

  // Persist detailContext (only group/item indices for potential future use)
  useEffect(() => {
    try {
      if (!detailContext) {
        localStorage.removeItem(DETAIL_CONTEXT_KEY);
      }
    } catch (e) {
      warn("Failed to clear detail context", e);
    }
  }, [detailContext]);

  // Debug: expose item inspector for diagnosing per-item sync/SRS issues
  // Call from browser console: __debugItems('atlas') or __debugItems('first half')
  useEffect(() => {
    (window as any).__debugItems = (word: string) => {
      const w = word.toLowerCase().trim();
      const matches = latestItemsRef.current.filter(i => getItemSpelling(i) === w);
      if (matches.length === 0) {
        console.log(`[Debug] No items found for "${word}"`);
        return;
      }
      console.log(`[Debug] Found ${matches.length} item(s) for "${word}":`);
      matches.forEach((item, idx) => {
        console.log(`  [${idx}] id=${item.data.id}, type=${item.type}, deleted=${!!item.isDeleted}, archived=${!!item.isArchived}`);
        console.log(`       SRS: reviews=${item.srs?.totalReviews}, strength=${item.srs?.memoryStrength}, stability=${item.srs?.stability}d, streak=${item.srs?.correctStreak}`);
        console.log(`       lastReview=${item.srs?.lastReviewDate ? new Date(item.srs.lastReviewDate).toISOString() : 'never'}, nextReview=${item.srs?.nextReview ? new Date(item.srs.nextReview).toISOString() : 'N/A'}`);
        console.log(`       updatedAt=${item.updatedAt ? new Date(item.updatedAt).toISOString() : 'N/A'}, savedAt=${new Date(item.savedAt).toISOString()}`);
        console.log(`       lastSyncedHash=${item.lastSyncedHash || 'NONE'}, currentHash=${getItemContentHash(item)}`);
      });
    };
    return () => { delete (window as any).__debugItems; };
  }, []);

  // Network status detection for offline support
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Bulk refresh state
  const [bulkRefreshProgress, setBulkRefreshProgress] = useState<{ current: number; total: number; isRunning: boolean } | null>(null);
  // Phase 2 dedup tool: variant-duplicate clusters under review (null = modal closed).
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateClusterView[] | null>(null);
  // Bulk TTS pre-generation sweep progress (null = not running).
  const [ttsGenProgress, setTtsGenProgress] = useState<{ current: number; total: number; isRunning: boolean } | null>(null);
  const ttsGenAbortRef = useRef(false);

  // Batch import state
  const [batchImportProgress, setBatchImportProgress] = useState<{
    current: number; total: number; skipped: number; failed: number; saved: number; isRunning: boolean;
  } | null>(null);
  const batchImportAbortRef = useRef(false);

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'success' | 'info';
    onConfirm: () => void;
    showCancel?: boolean;
  } | null>(null);

  // Keyboard shortcuts help modal
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const openKeyboardHelp = useCallback(() => setShowKeyboardHelp(true), []);

  // Global keyboard navigation for tab switching (1, 2, 3 keys)
  useGlobalNavigation({
    onNavigateToNotebook: () => {
      setCurrentView('notebook');
    },
    onNavigateToSentences: () => {
      setCurrentView('sentences');
    },
    onNavigateToStudy: () => {
      setCurrentView('study');
    },
    enabled: !detailContext && !confirmModal && !showKeyboardHelp && !cardPopup, // Disable when modals are open
  });

  // Global Escape key to close modals or go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
        } else if (cardPopup) {
          setCardPopup(null);
        } else if (confirmModal) {
          setConfirmModal(null);
        } else if (detailContext) {
          setDetailContext(null);
        }
      }
      
      // Cmd+F to focus notebook search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setCurrentView('notebook');
        // Focus notebook search input
        setTimeout(() => {
          const input = document.querySelector('input[placeholder*="Search or look up"]') as HTMLInputElement;
          input?.focus();
          input?.select();
        }, 100);
      }
      
      // ? key to show keyboard shortcuts (works even from input fields)
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowKeyboardHelp(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [detailContext, confirmModal, showKeyboardHelp, cardPopup]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Force sync — uploads changed items, pulls remote, merges
  const forceSyncInProgressRef = useRef(false);
  const handleForceSync = useCallback(async () => {
    if (forceSyncInProgressRef.current) return;
    forceSyncInProgressRef.current = true;

    setSyncStatus('syncing');

    try {
      await flushPendingReviews();
      await inSyncLane(async () => {
        await syncFullSnapshot();
        const pushed = await pushNow();
        if (pushed > 0) log(`Server: Force sync uploaded ${pushed} changed items`);
      });
      setSyncStatus('saved');
    } catch (e) {
      logError("Force Sync Failed:", e);
      setSyncStatus('error');
    } finally {
      forceSyncInProgressRef.current = false;
    }
  }, [flushPendingReviews, inSyncLane, syncFullSnapshot, pushNow]);

  // Save data before page unload (refresh, close tab, navigate away)
  // This is a critical safety net to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      const currentItems = latestItemsRef.current;
      if (isLoaded && currentItems.length > 0) {
        // Reviews are already in the synchronous outbox; IndexedDB may not finish but is worth trying.
        // Only items replaced since their last write are written, so this is cheap when nothing changed.
        userSaveData(currentItems).catch(e => warn("Failed to save on beforeunload:", e));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLoaded]);

  // Save data when app goes to background. Returning triggers the delta pull below.
  useEffect(() => {
      const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
              window.speechSynthesis?.cancel();
          } else {
              const currentItems = latestItemsRef.current;
              if (isLoaded && currentItems.length > 0) {
                  userSaveData(currentItems).catch(e => {
                      warn("Failed to save on visibility change:", e);
                  });
                  // Best-effort server push before the OS suspends the page
                  pushDirtyItems().catch(e => {
                      warn("Server push on background failed:", e);
                  });
              }
          }
      };

      const handleBeforeExternalNav = () => {
        const currentItems = latestItemsRef.current;
        if (!isLoaded || currentItems.length === 0) return;
        log("💾 Saving state before external navigation...");
        userSaveData(currentItems).catch(e => {
          warn("Failed to save to IDB before external nav:", e);
        });
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('dictprop:before-external-nav', handleBeforeExternalNav);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('dictprop:before-external-nav', handleBeforeExternalNav);
      };
  }, [isLoaded, userSaveData, pushDirtyItems]);

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    if (!authState.user) return;
    const userId = authState.user.id;
    const initStorage = async () => {
        try {
            clearLegacyLibraryCaches();
            // IndexedDB is the only local copy of the library; the server sync fills anything it lacks.
            const stored = await loadData(userId);
            const loadedItems = stored.items.filter(item =>
                item && item.data && item.data.id && item.srs && item.type
            );
            // The server won't resend a skipped record's changes, so a skipped record needs a full sync.
            const cursor = loadedItems.length === stored.items.length ? stored.cursor : null;
            log(`📦 Loaded ${loadedItems.length} items from IndexedDB`);

            // Each migration replaces only the items it changes, so the save below writes just those.
            const now = Date.now();
            let processedItems = loadedItems.map(item => {
                let migrated = item;
                // 1. SRS migration
                if (typeof migrated.srs?.memoryStrength !== 'number' ||
                    (migrated.type === 'sentence' && (migrated.srs?.totalReviews ?? 0) === 0 &&
                        ((migrated.srs?.memoryStrength ?? 0) !== 0 || (migrated.srs?.stability ?? 0.5) !== 0.5))) {
                    migrated = { ...migrated, srs: SRSAlgorithm.migrate(migrated.srs) };
                }
                // 2. Timestamp fix (for sync)
                if (!migrated.updatedAt && !migrated.savedAt) {
                    migrated = { ...migrated, savedAt: now, updatedAt: now };
                }
                // 3. Merge every legacy project into the one notebook without touching card content or SRS.
                if (migrated.project !== undefined) {
                    const { project: _legacyProject, ...withoutProject } = migrated;
                    migrated = withoutProject;
                }
                return migrated;
            });

            // 4. A review mutation is written synchronously before the async IndexedDB write. Reapply
            // those tiny patches here so an immediate refresh cannot roll progress back. The review
            // outbox delivers them, so a clean item stays clean, as in updateSRS.
            const beforeOverlay = processedItems;
            processedItems = overlayPendingReviews(beforeOverlay, readPendingReviewMutations(userId))
                .map((item, index) => item !== beforeOverlay[index] && !isItemDirty(beforeOverlay[index])
                    ? { ...item, lastSyncedHash: getItemContentHash(item) }
                    : item);

            // 5. Strip images from items → IDB (keep ~143MB out of React state)
            processedItems = await stripAndStoreImages(processedItems);

            // 6. Tombstones past retention have reached every device
            const pruned = dropExpiredTombstones(processedItems);
            processedItems = pruned.items;
            await deleteItemRecords(pruned.droppedIds, userId)
                .catch(error => warn('Expired deletions stay stored until the next launch:', error));

            updateItems(() => processedItems);
            serverCursorRef.current = cursor;

            // 7. Write back the items the steps above replaced
            await saveData(processedItems, userId);
        } catch (e) {
            logError("Failed to initialize storage", e);
        } finally {
            setIsLoaded(true);
        }
    };
    initStorage();
  }, [authState.user?.id]);

  // Helper to remove an item from detailContext groups and adjust indices
  const removeItemFromDetailContext = (id: string) => {
    setDetailContext(prev => {
      if (!prev) return null;
      if (prev.sentenceItems) return prev; // sentence mode → removeSentenceFromDetailContext handles it

      const newGroups = prev.groups.map(group => ({
        ...group,
        items: group.items.filter(item => item.data.id !== id)
      })).filter(group => group.items.length > 0);

      if (newGroups.length === 0) return null;

      let newGroupIndex = Math.min(prev.groupIndex, newGroups.length - 1);
      let newItemIndex = Math.min(prev.itemIndex, newGroups[newGroupIndex].items.length - 1);
      newItemIndex = Math.max(0, newItemIndex);

      return { groups: newGroups, groupIndex: newGroupIndex, itemIndex: newItemIndex };
    });
  };

  // Sentence-mode counterpart: a sentence's group is keyed by its source-word card id, so the
  // sentence's own id never matches in removeItemFromDetailContext. Remove the sentence and its
  // aligned group together, keeping `groups` and `sentenceItems` in lockstep. No-op outside sentence mode.
  const removeSentenceFromDetailContext = (sentenceId: string) => {
    setDetailContext(prev => {
      if (!prev || !prev.sentenceItems) return prev;
      const idx = prev.sentenceItems.findIndex(s => s.data.id === sentenceId);
      if (idx === -1) return prev;
      const newSentenceItems = prev.sentenceItems.filter((_, i) => i !== idx);
      const newGroups = prev.groups.filter((_, i) => i !== idx);
      if (newSentenceItems.length === 0) return null; // reviewed/deleted the last one → close
      const newGroupIndex = Math.min(prev.groupIndex, newGroups.length - 1);
      return { ...prev, groups: newGroups, sentenceItems: newSentenceItems, groupIndex: newGroupIndex, itemIndex: 0 };
    });
  };

  // Cache a bounded set of study-relevant images by default. A full offline pack is explicit.
  const prefetchImages = useCallback(async (items: StoredItem[], mode: 'priority' | 'all' = 'priority') => {
    if (mode === 'priority') {
      const connection = (navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }).connection;
      if (connection?.saveData || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return;
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      if (estimate?.quota && estimate.usage && estimate.usage / estimate.quota > 0.85) return;
    }

    const candidates = mode === 'all'
      ? items
      : (() => {
          const now = Date.now();
          const dueSoon = items
            .filter(item => !item.isDeleted && !item.isArchived && (item.srs?.nextReview || 0) <= now + 24 * 60 * 60 * 1000)
            .sort((a, b) => (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0))
            .slice(0, 60);
          const recent = items
            .filter(item => !item.isDeleted && !item.isArchived)
            .sort((a, b) => b.savedAt - a.savedAt)
            .slice(0, 20);
          return Array.from(new Map([...dueSoon, ...recent].map(item => [item.data.id, item])).values());
        })();

    // Collect all item/vocab IDs that have image markers
    const idsWithImages: string[] = [];
    const imageVersions = new Map<string, string>();
    const addImageMarker = (id: string, imageUrl: string | undefined) => {
      if (!isImageMarker(imageUrl)) return;
      idsWithImages.push(id);
      const version = getServerImageVersion(imageUrl);
      if (version) imageVersions.set(id, version);
    };
    for (const item of candidates) {
      if (item.isDeleted || item.isArchived) continue;
      const data = item.data as any;
      addImageMarker(data.id, data.imageUrl);
      if (Array.isArray(data.vocabs)) {
        for (const v of data.vocabs) {
          addImageMarker(v.id, v.imageUrl);
        }
      }
    }
    if (idsWithImages.length === 0) return;

    // Check which IDs already have images in IDB
    const alreadyStored = await getStoredImageIds(idsWithImages, imageVersions);
    const missing = idsWithImages.filter(id => !alreadyStored.has(id));
    if (missing.length === 0) return;

    // Sort by SRS nextReview (soonest first) so study-relevant images load first
    const srsMap = new Map<string, number>();
    for (const item of items) {
      const nrd = (item.srs as any)?.nextReview;
      if (nrd) {
        srsMap.set(item.data.id, nrd);
        if (Array.isArray((item.data as any).vocabs)) {
          for (const v of (item.data as any).vocabs) {
            srsMap.set(v.id, nrd);
          }
        }
      }
    }
    missing.sort((a, b) => (srsMap.get(a) || Infinity) - (srsMap.get(b) || Infinity));

    log(`🖼️ Caching ${missing.length} ${mode === 'all' ? 'offline' : 'priority'} images...`);
    prefetchAbortRef.current = false;
    setImagePrefetchProgress({ done: 0, total: missing.length });

    const BATCH_SIZE = 20;
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      if (prefetchAbortRef.current) break;
      const batch = missing.slice(i, i + BATCH_SIZE);
      try {
        const images = await loadItemImagesBatch(batch, imageVersions);
        const toSave = Object.entries(images).map(([id, base64]) => ({
          id,
          base64,
          version: imageVersions.get(id),
        }));
        if (toSave.length > 0) await saveImagesBatch(toSave, { remember: false });
        done += batch.length;
        setImagePrefetchProgress({ done, total: missing.length });
      } catch (e) {
        warn("Image pre-fetch batch failed:", e);
        done += batch.length;
        setImagePrefetchProgress({ done, total: missing.length });
      }
      // Yield to main thread between batches
      await new Promise(r => setTimeout(r, 100));
    }
    log(`🖼️ Pre-fetch complete: ${done}/${missing.length} images`);
    // Clear progress after a short delay
    setTimeout(() => setImagePrefetchProgress(null), 3000);
  }, []);

  const handleDownloadOfflineImages = useCallback(() => {
    void prefetchImages(latestItemsRef.current, 'all');
  }, [prefetchImages]);

  // Recovery: re-upload images that exist in THIS device's IndexedDB but are missing on
  // the server (e.g. images corrupted by the old marker-clobber bug). Run from a device
  // that still has the images cached. No-op on a fresh device (empty IDB).
  const handleRestoreImagesToServer = useCallback(async () => {
    try {
      setImageRestoreProgress({ done: 0, total: 0 });
      const [manifest, localIds] = await Promise.all([
        getServerImageManifest(),
        getAllStoredImageIds(),
      ]);

      // Only restore images that belong to a current (non-deleted) item or vocab.
      const liveIds = new Set<string>();
      for (const item of latestItemsRef.current) {
        if (item.isDeleted) continue;
        liveIds.add(item.data.id);
        const vocabs = (item.data as any).vocabs;
        if (Array.isArray(vocabs)) for (const v of vocabs) if (v?.id) liveIds.add(v.id);
      }

      const missing = [...localIds].filter(id => !manifest.has(id) && liveIds.has(id));
      log(`🖼️ Restore: ${localIds.size} local, ${manifest.size} on server, ${missing.length} to upload`);
      if (missing.length === 0) {
        setImageRestoreProgress({ done: 0, total: 0 });
        setTimeout(() => setImageRestoreProgress(null), 3000);
        return;
      }

      setImageRestoreProgress({ done: 0, total: missing.length });
      const BATCH = 8;
      let done = 0;
      for (let i = 0; i < missing.length; i += BATCH) {
        const batchIds = missing.slice(i, i + BATCH);
        const imgs = await loadImagesByIds(batchIds);
        const map: Record<string, string> = {};
        for (const [id, b64] of imgs) map[id] = b64;
        if (Object.keys(map).length > 0) {
          try { await uploadImages(map); } catch (e) { warn('Restore upload batch failed:', e); }
        }
        done += batchIds.length;
        setImageRestoreProgress({ done, total: missing.length });
      }
      log(`🖼️ Restore complete: uploaded ${done}/${missing.length}`);
      setTimeout(() => setImageRestoreProgress(null), 3000);
    } catch (e) {
      warn('Restore images to server failed:', e);
      setImageRestoreProgress(null);
    }
  }, []);

  // 2. SERVER SYNC — once local data is loaded, pull what changed since it was stored
  useEffect(() => {
    if (!isLoaded) return;
    const syncFromServer = async () => {
      try {
        await flushPendingReviews();
        await inSyncLane(async () => {
          // Server items carry image markers, never base64, so there is nothing to strip.
          await syncWithServer();
          const pushed = await pushNow();
          if (pushed > 0) log(`Server: uploaded ${pushed} items that differed from the server`);
        });
        void prefetchImages(latestItemsRef.current);
      } catch (error) {
        logError("Initial server sync failed:", error);
      } finally {
        initialServerSyncDoneRef.current = true;
      }
      storeMissingItemHashes(currentUserIdRef.current)
        .catch(error => warn('Storing item hashes will retry on the next launch:', error));
    };
    void syncFromServer();
  }, [isLoaded, flushPendingReviews, inSyncLane, syncWithServer, pushNow, prefetchImages]);

  const deltaPullInProgressRef = useRef(false);
  const pullServerChanges = useCallback(async () => {
    if (!authState.user || !initialServerSyncDoneRef.current || deltaPullInProgressRef.current ||
        !navigator.onLine || document.visibilityState !== 'visible') return;
    deltaPullInProgressRef.current = true;
    try {
      await flushPendingReviews();
      await inSyncLane(syncWithServer);
    } catch (error) {
      warn('Background sync will retry:', error);
    } finally {
      deltaPullInProgressRef.current = false;
    }
  }, [authState.user?.id, flushPendingReviews, inSyncLane, syncWithServer]);

  useEffect(() => {
    if (!isLoaded || !authState.user) return;
    const tick = () => { void pullServerChanges(); };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = window.setInterval(tick, 8_000);
    const unsubscribe = subscribeToServerMutations(tick);
    window.addEventListener('online', tick);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', handleVisibility);
    tick();
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener('online', tick);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isLoaded, authState.user?.id, pullServerChanges]);

  // 3. SAVE EFFECTS (Persistence + Server Sync)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(async () => {
      try {
        // Writes only the items replaced since their last write.
        await userSaveData(latestItemsRef.current);
        if (!latestItemsRef.current.some(isItemDirty)) {
          setSyncStatus('saved');
          return;
        }
        setSyncStatus('syncing');
        // Items waiting on the review outbox are skipped, which leaves nothing pushed.
        const pushed = await pushDirtyItems();
        setSyncStatus(pushed > 0 ? 'saved' : 'idle');
      } catch (e) {
        logError("Sync error:", e);
        setSyncStatus('error');
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [savedItems, isLoaded, userSaveData, pushDirtyItems]);

  // Bulk refresh - actual execution
  const executeBulkRefresh = useCallback(async () => {
    // Group items by their title to avoid duplicate searches
    const titleMap = new Map<string, StoredItem[]>();
    latestItemsRef.current.filter(isActiveLibraryItem).forEach(item => {
      const title = getItemTitle(item).toLowerCase().trim();
      if (!titleMap.has(title)) {
        titleMap.set(title, []);
      }
      titleMap.get(title)!.push(item);
    });

    const uniqueTitles = Array.from(titleMap.keys());
    let processed = 0;
    let errors = 0;
    setBulkRefreshProgress({ current: 0, total: uniqueTitles.length, isRunning: true });

    for (const title of uniqueTitles) {
      const itemsWithTitle = titleMap.get(title)!;
      const originalItem = itemsWithTitle[0];
      const searchQuery = getItemTitle(originalItem);

      try {
        // Re-search with AI
        const newResult = await analyzeInput(searchQuery);
        
        // Update each item with matching title
        for (const item of itemsWithTitle) {
          // Find the matching vocab from the new result (by sense if available)
          let newData: any = newResult;
          
          if (item.type === 'vocab' && newResult.vocabs && newResult.vocabs.length > 0) {
            // Try to find matching sense
            const oldSense = (item.data as VocabCard).sense;
            const matchingVocab = oldSense 
              ? newResult.vocabs.find(v => v.sense === oldSense) || newResult.vocabs[0]
              : newResult.vocabs[0];
            newData = { ...matchingVocab, id: item.data.id };
          } else {
            // For phrases, use the full result
            newData = { ...newResult, id: item.data.id };
          }

          // Update the item while preserving SRS data
          replaceItem(item.data.id, current => ({ ...current, data: newData, type: item.type, updatedAt: Date.now() }));
        }

        processed++;
        setBulkRefreshProgress({ current: processed, total: uniqueTitles.length, isRunning: true });

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        logError(`Failed to refresh "${searchQuery}":`, error);
        errors++;
        processed++;
        setBulkRefreshProgress({ current: processed, total: uniqueTitles.length, isRunning: true });
      }
    }

    setBulkRefreshProgress(null);
    setConfirmModal({
      isOpen: true,
      title: 'Refresh Complete',
      message: `Processed: ${processed} unique words/phrases\nErrors: ${errors}`,
      confirmText: 'OK',
      variant: errors > 0 ? 'warning' : 'success',
      onConfirm: () => setConfirmModal(null),
      showCancel: false
    });
  }, [replaceItem]);

  // Bulk refresh - show confirmation first
  const handleBulkRefresh = useCallback(() => {
    const itemCount = latestItemsRef.current.filter(isActiveLibraryItem).length;
    if (itemCount === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'No Items',
        message: 'Your notebook is empty. Add some items first!',
        confirmText: 'OK',
        variant: 'info',
        onConfirm: () => setConfirmModal(null),
        showCancel: false
      });
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Refresh All Items?',
      message: `This will re-search all ${itemCount} items in your notebook with the latest AI analysis.\n\nThis may take a while and use API quota.`,
      confirmText: 'Refresh All',
      cancelText: 'Cancel',
      variant: 'warning',
      onConfirm: () => {
        setConfirmModal(null);
        executeBulkRefresh();
      }
    });
  }, [executeBulkRefresh]);

  // ── "Generate sentence speech" — server-side background backfill ───────────
  // Triggers the server to generate MiMo audio + whisper word-timings for EVERY saved sentence,
  // entirely on the box (idempotent + resumable) — the app does NOT need to stay open. Foreground
  // calls poll progress into the bar; `silent` (post-batch-import) just fires it. `itemIds` is ignored
  // now (the server backfills everything; idempotent so it costs nothing for already-done clips).
  const runSpeechGeneration = useCallback(async (_itemIds?: string[], opts?: { silent?: boolean }) => {
    let status;
    try {
      status = await startTtsBackfill();
    } catch {
      if (!opts?.silent) setConfirmModal({ isOpen: true, title: "Couldn't Start", message: 'Failed to reach the server to start generation.', confirmText: 'OK', variant: 'warning', onConfirm: () => setConfirmModal(null), showCancel: false });
      return;
    }
    if (opts?.silent) return; // background trigger — the server handles it; no UI, app can close.

    // Foreground: poll the server job's progress. Closing the app does NOT stop the server.
    ttsGenAbortRef.current = false;
    setTtsGenProgress({ current: status.done, total: status.total, isRunning: true });
    let last = status;
    while (!ttsGenAbortRef.current) {
      await new Promise(r => setTimeout(r, 3000));
      try { last = await getTtsBackfillStatus(); } catch { break; }
      setTtsGenProgress({ current: last.done, total: last.total, isRunning: !!last.running });
      if (!last.running) break;
    }
    setTtsGenProgress(null);
    if (!ttsGenAbortRef.current) setConfirmModal({
      isOpen: true,
      title: 'Speech Generated',
      message: `${last.generated} generated · ${Math.max(0, last.total - last.generated - last.failed)} already cached${last.failed ? `\n${last.failed} failed` : ''}`,
      confirmText: 'OK', variant: 'success', onConfirm: () => setConfirmModal(null), showCancel: false,
    });
  }, []);

  // Button handler: sweep ALL items, with modals. Wrapped so a click event isn't passed as `itemIds`.
  const handleGenerateAllSpeech = useCallback(() => { void runSpeechGeneration(); }, [runSpeechGeneration]);
  // Ref so handleBatchImport (declared with empty deps) can fire the post-import sweep.
  const runSpeechGenerationRef = useRef(runSpeechGeneration);
  runSpeechGenerationRef.current = runSpeechGeneration;

  // ── Find & merge variant duplicates (Phase 2 dedup tool) ──────────────────
  // Detection is read-only: cluster base words that are variants of one another
  // (run/running/ran), then open the review modal. Scans the whole notebook.
  const handleFindDuplicates = useCallback(() => {
    const activeItems = latestItemsRef.current.filter(isActiveLibraryItem);
    const clusters = findDuplicateClusters(activeItems);
    const detailed: DuplicateClusterView[] = clusters
      .map((baseWords, i) => {
        const set = new Set(baseWords);
        const clusterItems = activeItems.filter(
          it => it.type === 'vocab' && set.has(normalizeKey((it.data as VocabCard).word || ''))
        );
        const suggestedCanonical = [...baseWords].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
        return { id: `dup-${i}`, baseWords, items: clusterItems, suggestedCanonical };
      })
      .filter(c => c.items.length >= 2);

    if (detailed.length === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'No Duplicates Found',
        message: 'No variant duplicates detected — your words are already consolidated. 🎉',
        confirmText: 'OK',
        variant: 'success',
        onConfirm: () => setConfirmModal(null),
        showCancel: false,
      });
      return;
    }
    setDuplicateClusters(detailed);
  }, []);

  // Apply the user-confirmed merges: relabel to canonical, union forms, dedupe senses,
  // and push the changed items immediately (like delete/SRS paths).
  const handleMergeDuplicates = useCallback(async (merges: Array<{ baseWords: string[]; canonical: string }>) => {
    setDuplicateClusters(null);
    if (!merges || merges.length === 0) return;

    // applyMerges replaces items in place in a copy, so an index-wise identity check finds the changes.
    const before = latestItemsRef.current;
    const after = updateItems(items => applyMerges(items, merges));
    const changed = after.filter((item, index) => item !== before[index]);
    log(`🔀 Merge: ${changed.length} item(s) changed across ${merges.length} cluster(s)`);
    await persistChangedItems(changed, '🔀 Merge');
  }, [updateItems, persistChangedItems]);

  // ── Batch Import (background processing) ──────────────────────────────────

  const BATCH_CONCURRENCY = 5;

  // Refs for batch import to avoid stale closures
  const handleSaveRef = useRef<(item: StoredItem) => void>(() => {});

  const handleBatchImport = useCallback(async (words: string[]) => {
    if (words.length === 0) return;

    // Deduplicate against existing items
    const currentItems = latestItemsRef.current;
    const newWords: string[] = [];
    let skipped = 0;
    for (const word of words) {
      const w = word.toLowerCase().trim();
      const exists = currentItems.some(item => {
        if (item.isDeleted || item.type !== 'vocab') return false;
        return ((item.data as VocabCard).word || '').toLowerCase().trim() === w;
      });
      if (exists) {
        skipped++;
      } else {
        newWords.push(word);
      }
    }

    if (newWords.length === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'All Already Saved',
        message: `All ${words.length} words are already in your notebook.`,
        confirmText: 'OK',
        variant: 'info',
        onConfirm: () => setConfirmModal(null),
        showCancel: false,
      });
      return;
    }

    setBatchImportProgress({ current: 0, total: newWords.length, skipped, failed: 0, saved: 0, isRunning: true });
    batchImportAbortRef.current = false;

    let completed = 0;
    let failed = 0;
    let saved = 0;
    let index = 0;
    const failedWords: string[] = [];
    const importedItemIds: string[] = [];

    const processWord = async () => {
      while (index < newWords.length && !batchImportAbortRef.current) {
        const currentIndex = index++;
        const word = newWords[currentIndex];

        // Retry once on failure (with backoff for rate limiting)
        let lastError: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) {
              log(`Batch import: retrying "${word}" (attempt ${attempt + 1})`);
              await new Promise(r => setTimeout(r, 2000));
            }

            const result = await analyzeInput(word, { mode: 'batch' });

            for (const vocab of result.vocabs || []) {
              const vocabWord = (vocab.word || '').toLowerCase().trim();
              const alreadySaved = latestItemsRef.current.some(item => {
                if (item.type !== 'vocab') return false;
                const sw = ((item.data as VocabCard).word || '').toLowerCase().trim();
                const ss = (item.data as VocabCard).sense || '';
                return sw === vocabWord && ss === vocab.sense;
              });

              if (!alreadySaved) {
                const storedItem: StoredItem = {
                  data: vocab,
                  type: 'vocab',
                  savedAt: Date.now(),
                  srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
                };
                handleSaveRef.current(storedItem);
                saved++;
                importedItemIds.push(vocab.id);

                // Advanced metadata and images are added by the Mac-local enrichment cycle.
              }
            }
            lastError = null;
            break; // success — exit retry loop
          } catch (err: any) {
            lastError = err;
            const msg = err?.message || '';
            // Back off extra on rate limiting before retry
            if (msg.includes('429') || msg.includes('QUOTA')) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }

        if (lastError) {
          warn(`Batch import failed for "${word}":`, lastError?.message || '');
          failed++;
          failedWords.push(word);
        }

        completed++;
        setBatchImportProgress({ current: completed, total: newWords.length, skipped, failed, saved, isRunning: true });

        // Brief delay between requests to reduce rate limiting
        await new Promise(r => setTimeout(r, 300));
      }
    };

    // Launch concurrent workers
    const workers = Array.from(
      { length: Math.min(BATCH_CONCURRENCY, newWords.length) },
      () => processWord()
    );
    await Promise.all(workers);

    setBatchImportProgress(null);

    setConfirmModal({
      isOpen: true,
      title: 'Batch Import Complete',
      message: `${saved} vocab cards saved${skipped > 0 ? `\n${skipped} skipped (already saved)` : ''}${failed > 0 ? `\n${failed} failed` : ''}`,
      confirmText: failedWords.length > 0 ? 'Retry Failed' : 'OK',
      variant: failed > 0 ? 'warning' : 'success',
      onConfirm: () => {
        setConfirmModal(null);
        if (failedWords.length > 0) {
          handleBatchImport(failedWords);
        }
      },
      showCancel: failedWords.length > 0,
      cancelText: 'Dismiss',
    });

    // Persist the new basic cards immediately so the Mac-local enrichment cycle can discover them.
    // Audio remains safe to pre-generate here; advanced text and images do not use VPS inference.
    if (importedItemIds.length > 0) {
      void (async () => {
        const imported = latestItemsRef.current.filter(item => importedItemIds.includes(item.data.id));
        await persistChangedItems(imported, 'Batch import');
      })().catch(e => warn('Post-batch persistence failed:', e));
      runSpeechGenerationRef.current(importedItemIds, { silent: true }).catch(e => warn('Post-batch speech generation failed:', e));
    }
  }, []);

  const handleSave = useCallback((item: StoredItem) => {
    try {
      if (!item || !item.data || !item.data.id) {
        warn('⭐ handleSave: early return - missing item/data/id', item?.data?.id);
        return;
      }

      const rawTitle = getItemTitle(item);
      const incomingTitle = String(rawTitle || '').toLowerCase().trim();
      if (!incomingTitle) {
        warn('⭐ handleSave: early return - empty title', rawTitle);
        return;
      }
      log('⭐ handleSave: saving', incomingTitle, 'type:', item.type, 'id:', item.data.id);

      // The saved copy of this item: the same id, else the same title and type, and for vocab the same
      // sense, so each meaning of a word keeps its own card. Resolve it before offloading images: the
      // saved item's stable id is also the image key, so uploading under a transient AI id would
      // orphan the new image when the content is merged into an existing card.
      const incomingSense = isVocabItem(item) ? (item.data.sense || '') : '';
      const findExistingIndex = (items: StoredItem[]): number => {
        const byId = items.findIndex(existing => existing.data.id === item.data.id);
        if (byId >= 0) return byId;
        return items.findIndex(existing => {
          if (existing.type !== item.type || getItemSpelling(existing) !== incomingTitle) return false;
          return !isVocabItem(item) || (isVocabItem(existing) && (existing.data.sense || '') === incomingSense);
        });
      };
      const canonicalItemId = latestItemsRef.current[findExistingIndex(latestItemsRef.current)]?.data.id || item.data.id;

      // Offload any base64 images to IDB before putting into state
      const imagesToSave: Array<{ id: string; base64: string }> = [];
      let data = item.data;
      if (isVocabItem(item) && (data as VocabCard).imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: canonicalItemId, base64: (data as VocabCard).imageUrl! });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
      }
      if (isPhraseItem(item)) {
        const sr = data as SearchResult;
        if (sr.imageUrl?.startsWith('data:image/')) {
          imagesToSave.push({ id: canonicalItemId, base64: sr.imageUrl });
          data = { ...data, imageUrl: IMAGE_IDB_MARKER } as SearchResult;
        }
        if (sr.vocabs?.length) {
          let vc = false;
          const nv = sr.vocabs.map(v => {
            if (v.imageUrl?.startsWith('data:image/')) {
              imagesToSave.push({ id: v.id, base64: v.imageUrl });
              vc = true;
              return { ...v, imageUrl: IMAGE_IDB_MARKER };
            }
            return v;
          });
          if (vc) data = { ...data, vocabs: nv } as SearchResult;
        }
      }
      if (imagesToSave.length > 0) void offloadImages(imagesToSave);

      const now = Date.now();
      const itemToSave = {
        ...item,
        data,
        updatedAt: now,
        savedAt: item.savedAt || now,
        isDeleted: false
      };

      updateItems(items => {
        const existingIndex = findExistingIndex(items);
        if (existingIndex < 0) {
          // Each meaning owns its own FSRS card. A newly saved sense must not inherit another
          // sense's difficulty, lapses, or due date just because the spelling matches.
          const normalizedSRS = SRSAlgorithm.ensure(itemToSave.srs, itemToSave.data.id, itemToSave.type);
          return [{ ...itemToSave, srs: normalizedSRS, savedAt: now, updatedAt: now }, ...items];
        }

        const existingItem = items[existingIndex];
        // FORCE keeping the existing ID to ensure consistency
        const idToUse = existingItem.data.id;
        // Prefer the incoming SRS, which likely carries updates (e.g. from DetailView)
        const mergedSrs = SRSAlgorithm.ensure(itemToSave.srs || existingItem.srs, idToUse, existingItem.type);
        mergedSrs.id = idToUse;
        const next = items.slice();
        next[existingIndex] = {
          ...itemToSave,
          data: { ...itemToSave.data, id: idToUse },
          savedAt: existingItem.savedAt || now,
          updatedAt: now,
          srs: mergedSrs,
          // A fresh AI result carries no revision, so it builds on the saved copy's. What the server
          // holds is known from the saved copy, whatever the incoming copy last saw.
          serverRevision: itemToSave.serverRevision ?? existingItem.serverRevision,
          lastSyncedHash: existingItem.lastSyncedHash,
        };
        return next;
      });
    } catch (err) {
      logError("Error during save operation:", err);
    }
  }, [updateItems]);

  // Keep batch import refs up to date
  handleSaveRef.current = handleSave;

  /**
   * Lazy load image from server via dedicated binary endpoint.
   * Returns base64 data URI directly (no polling needed).
   * Also saves to IDB for offline access.
   */
  const handleLazyLoadImage = useCallback(async (itemId: string, imageVersion?: string): Promise<string | null> => {
    // 1) Server has it? loadItemImage THROWS on a transient failure (OfflineImage retries) and returns
    //    null only for a genuine 404 (the image is truly gone). Persist a hit to IDB for instant replay.
    const existing = await loadItemImage(itemId, imageVersion);
    if (existing) {
      try { await saveImage(itemId, existing, imageVersion); } catch { /* cache write is best-effort */ }
      log(`🖼️ Lazy-loaded image from server for: ${itemId}`);
      return existing;
    }

    // A genuine 404 remains empty until the Mac-local enrichment cycle generates and uploads it.
    return null;
  }, []);

  // Attach a user-pasted/picked image to a sentence under review. Mirrors the vocab/phrase image path:
  // offload the base64 to IDB (awaited, for instant offline display) + upload to the server, then mark
  // the item's imageUrl and persist it. handleSave's own offload block only covers vocab/phrase, so the
  // offload is done explicitly here and the item is saved with the marker (never raw base64 in state).
  const handleAttachSentenceImage = useCallback(async (item: StoredItem, base64: string) => {
    if (!item?.data?.id || !base64.startsWith('data:image/')) return;
    await offloadImages([{ id: item.data.id, base64 }]);
    handleSaveRef.current({ ...item, data: { ...item.data, imageUrl: IMAGE_IDB_MARKER } });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    log('🗑️ App: Deleting item', id);
    const deleted = replaceItem(id, item => ({ ...item, isDeleted: true, updatedAt: Date.now() }));
    if (!deleted) warn('🗑️ App: Item not found for deletion:', id);

    // Update carousel immediately so card disappears instantly. Call both removers — each is a
    // no-op for the other mode (word id vs sentence id), so handleDelete stays mode-agnostic.
    removeItemFromDetailContext(id);
    removeSentenceFromDetailContext(id);

    // Persist and push the deletion now rather than after the debounce
    if (deleted) await persistChangedItems([deleted], 'Delete');
  }, [replaceItem, persistChangedItems]);

  const handleArchive = useCallback(async (id: string) => {
    log('📦 App: Archiving item', id);
    const archived = replaceItem(id, item => ({ ...item, isArchived: true, updatedAt: Date.now() }));
    if (!archived) warn('📦 App: Item not found for archiving:', id);

    // Update the carousel immediately, before the server sync finishes.
    removeItemFromDetailContext(id);

    if (archived) await persistChangedItems([archived], 'Archive');
  }, [replaceItem, persistChangedItems]);

  const handleRemoveVocabFromPhrase = useCallback(async (phraseId: string, vocabId: string) => {
    log('🗑️ App: Removing vocab', vocabId, 'from phrase', phraseId);
    // A phrase keeps at least one vocab.
    const phrase = latestItemsRef.current.find(i => i.data.id === phraseId);
    const vocabs = phrase && isPhraseItem(phrase) ? phrase.data.vocabs : undefined;
    if (!Array.isArray(vocabs) || vocabs.length <= 1) return;

    const updated = replaceItem(phraseId, item => {
      const phraseData = item.data as SearchResult;
      return {
        ...item,
        data: { ...phraseData, vocabs: (phraseData.vocabs || []).filter(v => v.id !== vocabId) },
        updatedAt: Date.now(),
      };
    });
    if (updated) await persistChangedItems([updated], 'Remove vocab');
  }, [replaceItem, persistChangedItems]);

  const handleUnarchive = useCallback(async (id: string) => {
    log('📦 App: Unarchiving item', id);
    const unarchived = replaceItem(id, item => ({ ...item, isArchived: false, updatedAt: Date.now() }));
    if (unarchived) await persistChangedItems([unarchived], 'Unarchive');
  }, [replaceItem, persistChangedItems]);

  // Word comparison handler (used by EVERY Compare button — synonyms + confusables). Non-blocking:
  // if we already have this comparison, open it instantly; otherwise enqueue it for background
  // generation (the bottom-right search button shows it in progress) and let the user keep working.
  // Trigger a comparison through the SAME bottom-right queue as word search (background, non-blocking).
  // If it's already saved, pass the cached result so the popup opens instantly; else it generates.
  const handleCompare = useCallback((words: string[]) => {
    if (words.length < 2) return; // no upper bound — compare against any number of words
    const key = comparisonKey(words);
    if (!key) return;
    const existing = comparisonsRef.current.find((c) => c.key === key);
    window.dispatchEvent(new CustomEvent('global-compare', { detail: { words, result: existing?.data ?? null } }));
  }, []);
  // Opening a saved comparison (from a word page) routes to the same place — the search popup.
  const handleOpenComparison = handleCompare;

  // Save sentence for review
  const handleSaveSentence = useCallback((text: string, sourceWord: string, sourceSense?: string, prepared?: SentenceData) => {
    const sentenceData: SentenceData = {
      id: crypto.randomUUID(),
      text,
      sourceWord,
      sourceSense,
      ...(prepared?.preferredSpeechStyle ? { preferredSpeechStyle: prepared.preferredSpeechStyle } : {}),
      ...(prepared?.catalogSentenceId ? { catalogSentenceId: prepared.catalogSentenceId } : {}),
      ...(prepared?.catalogCollectionId ? { catalogCollectionId: prepared.catalogCollectionId } : {}),
      ...(prepared?.catalogKind ? { catalogKind: prepared.catalogKind } : {}),
      ...(prepared?.catalogTitle ? { catalogTitle: prepared.catalogTitle } : {}),
      ...(prepared?.analysis ? { analysis: prepared.analysis } : {}),
      ...(prepared?.analysisGeneratedAt ? { analysisGeneratedAt: prepared.analysisGeneratedAt } : {}),
      ...(prepared?.imageUrl ? { imageUrl: prepared.imageUrl } : {}),
    };
    handleSaveRef.current({
      data: sentenceData,
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(sentenceData.id, 'sentence'),
    });
  }, []);

  // Both checks run once per rendered sentence or search result, so they look up prebuilt sets. They
  // read content only, so sentence reviews don't rebuild them.
  const sentenceContent = useStableArray(sentenceItems, sameItemContent);
  const savedSentenceIdentities = useMemo(
    () => new Set(sentenceContent.map(s => normalizeSentenceIdentity((s.data as SentenceData).text))),
    [sentenceContent],
  );
  const isSentenceSaved = useCallback((text: string) => {
    const identity = normalizeSentenceIdentity(text);
    return !!identity && savedSentenceIdentities.has(identity);
  }, [savedSentenceIdentities]);

  const savedVocabKeys = useMemo(() => new Set(
    activeContent.filter(isVocabItem).map(item => savedVocabKey(item.data)),
  ), [activeContent]);
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
    return sortVocabCardsByUsage(activeContent
      .filter(i => i.type === 'vocab' && bases.has(normalizeKey((i.data as VocabCard).word || '')))
      .map(i => i.data as VocabCard));
  }, [activeContent, variantIndex]);

  // Footnote lookup: the saved item (vocab or phrase) a sentence term maps to, or null. Variant-aware
  // for vocab (running→run etc.) via variantIndex; exact normalized match for phrases. Picks the
  // most useful modern-American sense, using review count only as a tie-breaker.
  const findSavedItem = useCallback((term: string): StoredItem | null => {
    const bases = matchBaseWords(term, variantIndex);
    if (bases.size === 0) return null;
    // O(candidates) via the prebuilt index — NOT an O(n) scan per token (this runs per word in every
    // rendered sentence). Vocab only; multi-word vocab still matches via variantKeys.
    let best: StoredItem | null = null;
    for (const b of bases) {
      const it = savedVocabByBase.get(b);
      if (it && (!best || (it.srs?.totalReviews ?? 0) > (best.srs?.totalReviews ?? 0))) best = it;
    }
    return best;
  }, [variantIndex, savedVocabByBase]);

  // Cheap boolean variant check (no card collection) — for Notebook's "auto-AI if no match" gate.
  const hasSavedVariant = useCallback((q: string) => matchBaseWords(q, variantIndex).size > 0, [variantIndex]);

  // Refresh-replace: a real re-run of the AI for an already-saved word replaces its saved card(s).
  // A meaning present in both old and new updates IN PLACE (handleSave matches by word+sense and we pass
  // its existing SRS), so spaced-repetition progress survives the refresh; brand-new meanings are added.
  // Unmatched saved senses remain: model sense coverage varies between calls, so omission is not evidence
  // that a valid stored meaning should be deleted. Called again as illustrations stream in (GlobalSearch).
  const handleRefreshReplace = useCallback((word: string, vocabs: VocabCard[]) => {
    if (!vocabs?.length) return;
    const spelling = word.toLowerCase().trim();
    const oldItems = latestItemsRef.current.filter(i =>
      !i.isDeleted && isVocabItem(i) && getItemSpelling(i) === spelling
    );
    vocabs.forEach(vocab => {
      const match = oldItems.find(o => ((o.data as VocabCard).sense || '') === (vocab.sense || ''));
      if (match) {
        // Update IN PLACE: keep the saved item's id/SRS/savedAt, swap in the fresh content.
        // A refresh replaces the card BEFORE its new image has been generated, then re-saves once the
        // image streams in. Carry the existing image forward when the fresh vocab has none yet, so the
        // word is never left imageless — if the user navigates away (or the image gen fails) mid-refresh
        // it simply keeps its old image instead of losing it.
        const prevImage = (match.data as VocabCard).imageUrl;
        handleSaveRef.current({ ...match, data: { ...vocab, id: match.data.id, imageUrl: vocab.imageUrl ?? prevImage }, srs: match.srs, savedAt: match.savedAt });
      } else {
        handleSaveRef.current({
          data: vocab,
          type: 'vocab',
          savedAt: Date.now(),
          srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
        });
      }
    });
  }, []);

  // Search handler - triggers GlobalSearch popup (bottom-right search icon)
  const handleRecursiveSearch = useCallback((text: string) => {
      window.dispatchEvent(new CustomEvent('global-search', { detail: { query: text } }));
  }, []);

  // Refresh handler - re-runs the AI for a word through the SAME bottom-right GlobalSearch
  // (forceAI bypasses the saved-card reuse and auto-opens the result). Used by the detail-view
  // refresh button so refreshing routes to the bottom-right icon, not the notebook top bar.
  const handleRefreshViaGlobal = useCallback((text: string) => {
      window.dispatchEvent(new CustomEvent('global-search', { detail: { query: text, forceAI: true } }));
  }, []);

  // Search handler that navigates to notebook (used by notebook's own search)
  const handleNotebookSearch = useCallback((text: string) => {
      setCurrentView('notebook');
      setDetailContext(null);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('notebook-search', { detail: { query: text, forceAI: false, autoAIIfNoMatch: true } }));
      }, 100);
  }, []);

  // Updated handler to support groups
  const handleViewStoredItem = useCallback((groups: ItemGroup[], groupIndex: number, itemIndex: number) => {
      setDetailContext({ groups, groupIndex, itemIndex });
  }, []);

  // Open a saved sentence's source card in DetailView (sentence mode). `ordered` is the on-screen
  // (due-first) order from SentencesView, so swipe/arrow order matches the list exactly. Each sentence
  // maps to one group whose single item is its resolved source vocab card — matched by word + sense
  // across the whole notebook, falling back to a synthetic minimal card (showing the
  // sentence as its sole example) when the source word no longer exists.
  const handleViewSentence = useCallback((ordered: StoredItem[], index: number) => {
    if (ordered.length === 0) return;
    const vocabBySpelling = new Map<string, StoredItem[]>();
    for (const item of latestItemsRef.current) {
      if (item.isDeleted || item.type !== 'vocab') continue;
      const spelling = getItemSpelling(item);
      const matches = vocabBySpelling.get(spelling);
      if (matches) matches.push(item);
      else vocabBySpelling.set(spelling, [item]);
    }
    const groups: ItemGroup[] = ordered.map(s => {
      const d = s.data as SentenceData;
      const w = (d.sourceWord || '').toLowerCase().trim();
      const matches = vocabBySpelling.get(w) ?? [];
      const exact = d.sourceSense ? matches.find(i => getItemSense(i) === d.sourceSense) : undefined;
      let resolved: StoredItem | undefined = exact || matches[0];
      if (!resolved) {
        const synthetic: VocabCard = {
          id: `sentence-src:${d.id}`,
          word: d.sourceWord || '(unknown word)',
          sense: d.sourceSense,
          chinese: '',
          ipa: '',
          definition: '',
          forms: [],
          wordFamily: [],
          synonyms: [],
          antonyms: [],
          confusables: [],
          examples: [d.text],
          history: '',
          register: '',
          mnemonic: '',
        };
        resolved = { data: synthetic, type: 'vocab', savedAt: Date.now(), srs: SRSAlgorithm.createNew(synthetic.id, 'vocab') };
      }
      return { title: getItemTitle(resolved), items: [resolved] };
    });
    const safeIndex = Math.min(Math.max(0, index), groups.length - 1);
    setDetailContext({ groups, groupIndex: safeIndex, itemIndex: 0, sentenceItems: ordered });
  }, []);

  // Resolve an example to a sentence card without changing the notebook. Prepared analysis and its
  // image are global source material, so previewing can read them before the user explicitly saves.
  const prepareExampleSentence = useCallback(async (text: string, sourceWord: string, sourceSense?: string): Promise<StoredItem | null> => {
    const identity = normalizeSentenceIdentity(text);
    if (!identity) return null;

    const existing = latestItemsRef.current.find(item =>
      !item.isDeleted && isSentenceItem(item) && !isRealLifeProgressItem(item) && !isEssayProgressItem(item) &&
      normalizeSentenceIdentity((item.data as SentenceData).text) === identity
    );
    if (existing && (existing.data as SentenceData).analysis) return existing;

    const id = existing?.data.id ?? `sentence-preview:${crypto.randomUUID()}`;
    let enrichment = null;
    try {
      const { default: loadEnrichment } = await import('./services/sentenceEnrichment');
      enrichment = await loadEnrichment(text);
    } catch { /* The preview remains usable when prepared metadata is unavailable. */ }
    return {
      ...(existing ?? {
        type: 'sentence' as const,
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(id, 'sentence'),
      }),
      data: {
        ...(existing?.data as SentenceData | undefined),
        id,
        text,
        sourceWord,
        sourceSense,
        ...(enrichment ?? {}),
      },
    };
  }, []);

  const handleOpenStudyExample = useCallback(async (text: string, sourceWord: string, sourceSense?: string) => {
    const sentence = await prepareExampleSentence(text, sourceWord, sourceSense);
    if (sentence) handleViewSentence([sentence], 0);
  }, [handleViewSentence, prepareExampleSentence]);

  // Reset only this sense/item. Different meanings now keep independent FSRS schedules.
  const resetSRS = useCallback((id: string) => {
    const target = latestItemsRef.current.find(i => i.data.id === id);
    if (!target) return;
    handleSaveRef.current({ ...target, srs: SRSAlgorithm.createNew(target.data.id, target.type) });
  }, []);

  // SRS update for one sense/item. The server applies the same FSRS transition atomically.
  //
  // The reviewed copy is computed from latestItemsRef.current before any state update, so the review
  // outbox, the immediate IndexedDB write and the rendered library all hold the same copy.
  const updateSRS = useCallback(async (
    itemId: string,
    rating: ReviewRating = 'good',
    context?: {
      taskType?: ReviewTaskType;
      durationMs?: number;
      sessionId?: string;
      eventId?: string;
      /** Materializes an implicit catalog sentence on its first review. */
      seedItem?: StoredItem;
    },
  ): Promise<boolean> => {
    const now = Date.now();
    const userId = authState.user?.id || 'vps';

    const savedItem = latestItemsRef.current.find(i => i.data.id === itemId);
    const requestedSeed = context?.seedItem;
    const seedItem = !savedItem && requestedSeed?.data.id === itemId &&
      (isRealLifeProgressItem(requestedSeed) || isEssayProgressItem(requestedSeed))
      ? requestedSeed
      : undefined;
    const targetItem = savedItem ?? seedItem;
    if (!targetItem) return false;

    const targetTitle = getItemTitle(targetItem).toLowerCase().trim();
    const baseSRS = SRSAlgorithm.ensure(targetItem.srs, targetItem.data.id, targetItem.type);
    const updatedSRS = SRSAlgorithm.updateAfterRating(baseSRS, rating, now);
    const reviewEvent: ReviewEvent = {
      id: context?.eventId || crypto.randomUUID(), itemId, itemType: targetItem.type, reviewedAt: now,
      previousStep: baseSRS.totalReviews, nextStep: updatedSRS.totalReviews,
      rating,
      taskType: context?.taskType || 'quick',
      durationMs: context?.durationMs,
      sessionId: context?.sessionId,
    };

    log(`🧠 FSRS Update: ${targetTitle} - ${rating}, stability=${updatedSRS.stability.toFixed(1)}d, next review in ${updatedSRS.interval}m`);

    // The review outbox, not the item push, carries the new schedule (and a seed item) to the server.
    // A copy that matched the server before the review stays clean, so reconciling the applied review
    // adopts the server's content instead of mistaking the new schedule for an unsynced edit.
    const reviewed: StoredItem = { ...targetItem, srs: { ...updatedSRS, id: itemId }, updatedAt: now };
    const reviewedItem = seedItem || !isItemDirty(targetItem)
      ? { ...reviewed, lastSyncedHash: getItemContentHash(reviewed) }
      : reviewed;
    const reviewMutation: PendingReviewMutation = {
      event: reviewEvent,
      itemIds: [itemId],
      optimisticSrs: { [itemId]: reviewedItem.srs },
      ...(seedItem ? { seedItem } : {}),
    };

    // The small localStorage outbox is synchronous and lands before React or IndexedDB work. Its
    // idempotent event id is the crash/reload boundary for offline and rapid reviews.
    enqueuePendingReviewMutation(userId, reviewMutation);
    recordReview(reviewEvent, { persist: false });
    updateItems(items => {
      const index = items.findIndex(item => item.data.id === itemId);
      if (index < 0) return seedItem ? [...items, reviewedItem] : items;
      const next = items.slice();
      next[index] = reviewedItem;
      return next;
    });

    // CRITICAL: save to IndexedDB immediately (primary persistence — never lose progress on a quick
    // refresh / app switch).
    try {
      await saveItemUpdates([reviewedItem], userId);
    } catch (e) {
      logError('💾 Failed to save SRS update to IndexedDB:', e);
    }

    await flushPendingReviews();
    return !readPendingReviewMutations(userId).some(mutation => mutation.event.id === reviewEvent.id);
  }, [authState.user?.id, recordReview, updateItems, flushPendingReviews]);

  // Handle scroll to hide/show nav bar — uses direct DOM mutation to avoid re-rendering App
  const handleScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const scroller = e.currentTarget;
    const currentScrollY = scroller.scrollTop;
    const lastScrollY = lastScrollYs.current.get(scroller) ?? currentScrollY;
    let shouldShow = showNavRef.current;

    if (currentScrollY < 10) {
      shouldShow = true;
    } else if (currentScrollY > lastScrollY && currentScrollY > 100) {
      shouldShow = false;
    } else if (currentScrollY < lastScrollY) {
      shouldShow = true;
    }

    if (shouldShow !== showNavRef.current) {
      showNavRef.current = shouldShow;
      if (navRef.current) {
        navRef.current.classList.toggle('translate-y-full', !shouldShow);
        navRef.current.classList.toggle('translate-y-0', shouldShow);
      }
    }

    lastScrollYs.current.set(scroller, currentScrollY);
  }, []);

  // Auth gate: show login/pending/loading before the main app
  if (authState.loading) {
    return (
      <div className="fixed inset-0 bg-white flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!authState.user) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-indigo-50 to-white flex items-center justify-center">
        <div className="text-center space-y-6 p-8">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-slate-800">DictProp</h1>
            <p className="text-slate-500">AI-powered vocabulary learning</p>
          </div>
          <button
            onClick={loginRedirect}
            className="inline-flex items-center gap-3 px-6 py-3 bg-white border border-slate-200 rounded-lg shadow-sm hover:shadow-md hover:bg-slate-50 transition-all text-slate-700 font-medium"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (authState.pending) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-amber-50 to-white flex items-center justify-center">
        <div className="text-center space-y-4 p-8">
          <div className="w-12 h-12 mx-auto bg-amber-100 rounded-full flex items-center justify-center">
            <span className="text-2xl">⏳</span>
          </div>
          <h2 className="text-xl font-semibold text-slate-800">Pending Approval</h2>
          <p className="text-slate-500 max-w-sm">Your account is awaiting admin approval. Please check back later.</p>
          <button onClick={logout} className="text-sm text-slate-400 hover:text-slate-600 underline">Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-white flex flex-col">
      {!isLoaded ? (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : (
      <>
      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-amber-500 text-white text-center py-2 text-sm font-medium flex items-center justify-center gap-2 shrink-0">
          <span className="inline-block w-2 h-2 bg-white rounded-full animate-pulse" />
          Offline mode — changes will sync when connected
        </div>
      )}
      
      {imagePrefetchProgress && (
        <div className="bg-indigo-50 text-indigo-600 text-center py-1 text-xs font-medium shrink-0">
          Loading images: {imagePrefetchProgress.done}/{imagePrefetchProgress.total}
        </div>
      )}

      {imageRestoreProgress && (
        <div className="bg-emerald-50 text-emerald-700 text-center py-1 text-xs font-medium shrink-0">
          {imageRestoreProgress.total === 0
            ? 'All images already on the server ✓'
            : `Restoring images to server: ${imageRestoreProgress.done}/${imageRestoreProgress.total}`}
        </div>
      )}

      <Suspense fallback={null}>
      {confirmModal && (
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          variant={confirmModal.variant}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
          showCancel={confirmModal.showCancel}
        />
      )}

      {duplicateClusters && (
        <DuplicatesModal
          clusters={duplicateClusters}
          onClose={() => setDuplicateClusters(null)}
          onMerge={handleMergeDuplicates}
        />
      )}

      {/* Global background-job progress — remains visible across tabs/views. */}
      {ttsGenProgress?.isRunning && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[80] bg-indigo-600 text-white rounded-full shadow-xl px-4 py-2 flex items-center gap-3 fade-in">
          <Loader2 size={16} className="animate-spin shrink-0" />
          <span className="text-sm font-medium whitespace-nowrap">
            Generating sentence audio · {ttsGenProgress.current}/{ttsGenProgress.total}
            {(() => {
              const rem = ttsGenProgress.total - ttsGenProgress.current;
              if (rem <= 0) return '';
              const mins = Math.ceil((rem * 2.75) / 4 / 60);
              return ` · ~${mins}m left`;
            })()}
          </span>
          <div className="w-16 h-1.5 bg-indigo-400/60 rounded-full overflow-hidden">
            <div
              className="h-full bg-white transition-all duration-300"
              style={{ width: `${ttsGenProgress.total > 0 ? (ttsGenProgress.current / ttsGenProgress.total) * 100 : 0}%` }}
            />
          </div>
          <button
            onClick={() => { ttsGenAbortRef.current = true; }}
            className="ml-1 shrink-0 text-indigo-200 hover:text-white"
            title="Stop generating"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {detailContext && (
        <Suspense fallback={<div className="fixed inset-0 z-[54] grid place-items-center bg-white"><Loader2 className="animate-spin text-indigo-500" /></div>}>
        <ErrorBoundary
          onReset={closeDetail}
          fallbackMessage="Something went wrong displaying this card. Your data is safe — returning to notebook."
        >
          <DetailView
              groups={detailContext.groups}
              initialGroupIndex={detailContext.groupIndex}
              initialItemIndex={detailContext.itemIndex}
              sentenceItems={liveDetailSentenceItems}
              onClose={closeDetail}
              onSave={handleSave}
              onDelete={handleDelete}
              onArchive={handleArchive}
              savedItems={allActiveItems}
              savedSentenceItems={allSentenceItems}
              onSearch={handleRecursiveSearch}
              onRefresh={handleRefreshViaGlobal}
              onLazyLoadImage={handleLazyLoadImage}
              onUpdateSRS={updateSRS}
              onCompare={handleCompare}
              comparisons={comparisons}
              onOpenComparison={handleOpenComparison}
              onSaveSentence={handleSaveSentence}
              onOpenExampleSentence={prepareExampleSentence}
              isSentenceSaved={isSentenceSaved}
              isVocabSaved={isVocabSaved}
              onRemoveVocabFromPhrase={handleRemoveVocabFromPhrase}
              findSaved={findSavedItem}
              onOpenCard={openCardPopup}
              interactionLocked={!!cardPopup}
              onAttachImage={handleAttachSentenceImage}
          />
        </ErrorBoundary>
        </Suspense>
      )}

      {popupItems.length > 0 && cardPopup && (
        <Suspense fallback={<div className="fixed inset-0 z-[80] grid place-items-center bg-black/5"><Loader2 className="animate-spin text-indigo-500" /></div>}>
          <CardReviewPopup
              key={cardPopup.spelling}
              items={popupItems}
              initialId={cardPopup.initialId}
              onClose={closeCardPopup}
              onUpdateSRS={updateSRS}
              onResetSRS={resetSRS}
              onDelete={handleDelete}
              onSearch={handleRecursiveSearch}
              onRefresh={handleRefreshViaGlobal}
              onCompare={handleCompare}
              onSaveSentence={handleSaveSentence}
              isSentenceSaved={isSentenceSaved}
              onLazyLoadImage={handleLazyLoadImage}
              onFetchSenses={fetchSensesForWord}
              onSaveVocab={saveVocabSense}
          />
        </Suspense>
      )}
      </Suspense>

      <main className="flex-1 relative w-full min-h-0 overflow-hidden">
        <TabScreen shown={currentView === 'notebook'}>
          <NotebookView
            items={notebookItems}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onViewDetail={handleViewStoredItem}
            user={notebookUser}
            onSignIn={loginRedirect}
            onSignOut={logout}
            syncStatus={syncStatus}
            onScroll={handleScroll}
            onForceSync={handleForceSync}
            isOnline={isOnline}
            onBulkRefresh={handleBulkRefresh}
            bulkRefreshProgress={bulkRefreshProgress}
            hasSavedVariant={hasSavedVariant}
            isVocabSaved={isVocabSaved}
            onFindDuplicates={handleFindDuplicates}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onSave={handleSave}
            onCompare={handleCompare}
            onSaveSentence={handleSaveSentence}
            isSentenceSaved={isSentenceSaved}
            hasOverlay={!!detailContext || !!confirmModal || showKeyboardHelp || !!cardPopup}
            onBatchImport={handleBatchImport}
            onJSONImported={handleForceSync}
            batchImportProgress={batchImportProgress}
            onGenerateAllSpeech={handleGenerateAllSpeech}
            ttsGenProgress={ttsGenProgress}
            onRestoreImagesToServer={handleRestoreImagesToServer}
            imageRestoreRunning={imageRestoreProgress !== null}
            onDownloadOfflineImages={handleDownloadOfflineImages}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'study'}>
          <StudyEnhanced
            items={studyItems}
            reviewEvents={reviewEvents}
            onReview={updateSRS}
            onUndoReview={undoSRSReview}
            onOpenExampleSentence={handleOpenStudyExample}
            interactionLocked={!!detailContext}
            onScroll={handleScroll}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'sentences'}>
          <SentencesView
            items={sentenceItems}
            onUpdateSRS={updateSRS}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onScroll={handleScroll}
            onOpenSentence={handleViewSentence}
            findSaved={findSavedItem}
            onOpenCard={openCardPopup}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'real-life'}>
          <RealLifeView
            onOpenSentence={handleViewSentence}
            progressItems={realLifeProgressItems}
            onUpdateSRS={updateSRS}
            isSentenceSaved={isSentenceSaved}
            onScroll={handleScroll}
            findSaved={findSavedItem}
            onOpenCard={openCardPopup}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'essays'}>
          <EssaysView
            onOpenSentence={handleViewSentence}
            progressItems={essayProgressItems}
            onScroll={handleScroll}
          />
        </TabScreen>
      </main>

      <Suspense fallback={null}>
      <GlobalSearch
        onSave={handleSave}
        isVocabSaved={isVocabSaved}
        findSavedByWord={findSavedByWord}
        onSearch={handleRecursiveSearch}
        isOnline={isOnline}
        onLazyLoadImage={handleLazyLoadImage}
        onRefreshReplace={handleRefreshReplace}
        onSaveSentence={handleSaveSentence}
        isSentenceSaved={isSentenceSaved}
        onCompareReady={handleCompareReady}
        onCompare={handleCompare}
        sentenceItems={sentenceItems}
        onOpenSentence={handleViewSentence}
      />
      </Suspense>

      <Suspense fallback={null}>
        <AppNavigation
          ref={navRef}
          currentView={currentView}
          onNavigate={setCurrentView}
          sentenceDueCount={sentenceDueCount}
          onKeyboardHelp={openKeyboardHelp}
        />
      </Suspense>

      {/* Keyboard Shortcuts Help Modal */}
      <Suspense fallback={null}>
        {showKeyboardHelp && <KeyboardHelpModal onClose={() => setShowKeyboardHelp(false)} />}
      </Suspense>
      </>
      )}
    </div>
  );
};

export default App;
