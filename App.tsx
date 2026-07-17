import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { StoredItem, ViewState, SyncStatus, SyncState, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, VocabCard, SearchResult, SentenceData, ItemGroup, isPhraseItem, isVocabItem, isSentenceItem, ProjectInfo, StoredComparison, ComparisonResult, comparisonKey, ReviewEvent, type ReviewRating, type ReviewTaskType } from './types';
import { Book, BrainCircuit, Keyboard, MessageSquareQuote, Loader2, X } from 'lucide-react';
import { loadData, saveData, saveItemUpdates, migrateFromLocalStorage, saveImagesBatch, saveImage, getStoredImageIds, getAllStoredImageIds, loadImagesByIds } from './services/storage';
import { mergeDatasets } from './services/sync';
import { loadAllItems, loadItemChanges, saveItems, loadItemImage, loadItemImagesBatch, getItemContentHash, analyzeInput, generateIllustration, loadProjects, uploadImages, getServerImageManifest, startTtsBackfill, getTtsBackfillStatus, loadComparisons, saveComparisonApi, applyReviewMutation, undoReviewMutation, type RevisionCursor } from './services/api';
import { stripSentenceMarkers } from './components/HighlightedSentence';
import { checkAuth, loginRedirect, logout, AuthState } from './services/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { DuplicateClusterView } from './components/DuplicatesModal';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { buildVariantIndex, matchBaseWords, normalizeKey, findDuplicateClusters } from './services/wordMatch';
import { mergeGeneratedVocabIntoStoredItem } from './services/items';
import { AUTH_REQUIRED_EVENT } from './services/http';
import { enqueuePendingReviewMutation, excludePendingReviewItems, overlayPendingReviews, readPendingReviewMutations, removePendingReviewMutation, type PendingReviewMutation } from './services/reviewQueue';
import { useReviewHistory } from './hooks/useReviewHistory';
import { useGlobalNavigation } from './hooks';
import { log, warn, error as logError } from './services/logger';
import { subscribeToServerMutations } from './services/syncSignals';

// Project to land on by default each session (matched by name, case-insensitive).
// Falls back to "All Projects" if no project with this name exists. Change here to retarget.
const DEFAULT_PROJECT_NAME = 'everyone ESL';
const NotebookView = lazy(() => import('./views/Notebook').then(module => ({ default: module.NotebookView })));
const GlobalSearch = lazy(() => import('./components/GlobalSearch').then(module => ({ default: module.GlobalSearch })));
const ConfirmModal = lazy(() => import('./components/ConfirmModal').then(module => ({ default: module.ConfirmModal })));
const DuplicatesModal = lazy(() => import('./components/DuplicatesModal').then(module => ({ default: module.DuplicatesModal })));
const CardReviewPopup = lazy(() => import('./components/CardReviewPopup').then(module => ({ default: module.CardReviewPopup })));
const KeyboardHelpModal = lazy(() => import('./components/KeyboardHelpModal').then(module => ({ default: module.KeyboardHelpModal })));
const StudyEnhanced = lazy(() => import('./views/StudyEnhanced').then(module => ({ default: module.StudyEnhanced })));
const SentencesView = lazy(() => import('./views/SentencesView').then(module => ({ default: module.SentencesView })));
const DetailView = lazy(() => import('./views/DetailView').then(module => ({ default: module.DetailView })));

// Create lightweight cache for localStorage (target: <1MB for 3000+ items)
// Only includes fields needed for list display + SRS scheduling
// Full data loads from IndexedDB after initial render
const createLightweightCache = (items: StoredItem[]): any[] =>
  items.map(item => {
    const entry: any = {
      type: item.type,
      srs: item.srs,
      savedAt: item.savedAt,
      updatedAt: item.updatedAt,
      serverRevision: item.serverRevision,
    };
    if (item.isDeleted) entry.isDeleted = true;
    if (item.isArchived) entry.isArchived = true;
    if (item.project) entry.project = item.project;

    if (isPhraseItem(item)) {
      entry.data = {
        id: item.data.id,
        query: item.data.query,
        translation: item.data.translation,
        pronunciation: item.data.pronunciation,
        vocabs: (item.data.vocabs || []).map((v: VocabCard) => ({
          id: v.id, word: v.word, sense: v.sense, chinese: v.chinese, ipa: v.ipa,
        })),
        timestamp: item.data.timestamp,
      };
    } else if (isSentenceItem(item)) {
      entry.data = {
        id: item.data.id,
        text: item.data.text,
        sourceWord: item.data.sourceWord,
        sourceSense: item.data.sourceSense,
      };
    } else {
      const vocab = item.data as VocabCard;
      entry.data = {
        id: vocab.id, word: vocab.word, sense: vocab.sense,
        chinese: vocab.chinese, ipa: vocab.ipa,
      };
    }
    return entry;
  });

const offloadImages = async (images: Array<{ id: string; base64: string }>): Promise<void> => {
  const { offloadAndUpload } = await import('./services/imagePipeline');
  await offloadAndUpload(images);
};

function latestRevisionCursor(items: readonly StoredItem[]): RevisionCursor {
  return items.reduce<RevisionCursor>((cursor, item) => {
    const revision = item.serverRevision || 0;
    if (revision > cursor.revision || (revision === cursor.revision && item.data.id > cursor.id)) {
      return { revision, id: item.data.id };
    }
    return cursor;
  }, { revision: 0, id: '' });
}

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

// Check if an imageUrl is a marker (not real base64 data)
const isImageMarker = (url: string | undefined): boolean =>
  !!url && !url.startsWith('data:image/') && (url === IMAGE_IDB_MARKER || url === 'server:has_image');

/**
 * Strip base64 imageUrl fields from items and store them in IDB images store.
 * Also normalizes server markers ('server:has_image') to the client marker ('idb:stored').
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
      } else if (isImageMarker(vc.imageUrl)) {
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
      } else if (isImageMarker(sr.imageUrl)) {
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
          } else if (isImageMarker(v.imageUrl)) {
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

// Keyboard shortcut display component
const DETAIL_CONTEXT_KEY = 'app_detail_context';

const NavButton = ({ view, currentView, onClick, icon: Icon, label, badge }: { view: ViewState, currentView: ViewState, onClick: (view: ViewState) => void, icon: React.ComponentType<{ size?: number; strokeWidth?: number }>, label: string, badge?: number }) => (
  <button
    onClick={() => onClick(view)}
    className={`flex flex-col items-center justify-center flex-1 py-3 gap-1 transition-colors relative ${currentView === view ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
  >
    <div className="relative">
      <Icon size={24} strokeWidth={currentView === view ? 2.5 : 2} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 bg-violet-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
    <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
  </button>
);

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
    if (!saved || saved === 'search' || !['notebook', 'study', 'sentences'].includes(saved)) {
      return 'notebook';
    }
    return saved as ViewState;
  });

  // Persist current view
  useEffect(() => {
    localStorage.setItem('app_current_view', currentView);
  }, [currentView]);
  
  // Cache key is per-user to isolate data between accounts
  const cacheKey = authState.user ? `vps_items_cache_${authState.user.id}` : 'vps_items_cache';

  // Simplified sync state (items only)
  // Restore instantly from lightweight localStorage cache for fast perceived load
  const [syncState, setSyncState] = useState<SyncState>(() => {
    return { items: [] };
  });
  const latestItemsRef = useRef<StoredItem[]>(syncState.items);
  const serverCursorRef = useRef<RevisionCursor>({ revision: 0, id: '' });
  
  // Restore from localStorage cache once auth is resolved
  useEffect(() => {
    if (authState.loading || !authState.user) return;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const items = JSON.parse(cached);
        if (Array.isArray(items) && items.length > 0) {
          log(`⚡ Instant restore: ${items.length} items from cache`);
          latestItemsRef.current = items;
          serverCursorRef.current = latestRevisionCursor(items);
          setSyncState({ items });
        }
      }
    } catch (e) {
      warn("Failed to restore items from cache", e);
    }
  }, [authState.loading, authState.user?.id]);

  // User-scoped saveData wrapper — all saves go through this
  const userSaveData = useCallback((items: StoredItem[]) => {
    return saveData(items, authState.user?.id || 'vps');
  }, [authState.user?.id]);

  // Track when we last saved to avoid redundant saves from event handlers
  const lastSaveTimeRef = useRef<number>(0);

  // Incremented on every immediate push (SRS/delete/archive) so the debounced save
  // can detect a concurrent push happened during its async rehydration window.
  const syncGenerationRef = useRef(0);
  const initialServerSyncDoneRef = useRef(false);

  const currentUserIdRef = useRef(authState.user?.id || 'vps');
  currentUserIdRef.current = authState.user?.id || 'vps';

  const markItemsSynced = (ids: Set<string>) => {
    const revisions = new Map(latestItemsRef.current
      .filter(item => ids.has(item.data.id))
      .map(item => [item.data.id, item.serverRevision]));
    const mark = (items: StoredItem[]): StoredItem[] => items.map(item => ids.has(item.data.id) ? {
      ...item,
      serverRevision: revisions.get(item.data.id) ?? item.serverRevision,
      lastSyncedHash: getItemContentHash(item),
    } : item);
    latestItemsRef.current = mark(latestItemsRef.current);
    setSyncState(prevState => ({ ...prevState, items: mark(prevState.items) }));
  };

  // Durable local delta first, then immediate server sync. On network failure the
  // item stays dirty and the normal debounce retries it later.
  const persistChangedItems = async (items: StoredItem[], label: string): Promise<void> => {
    if (items.length === 0) return;
    try {
      await saveItemUpdates(items, currentUserIdRef.current);
    } catch (error) {
      logError(`${label}: failed to journal local update`, error);
    }

    try {
      const serverItems = excludePendingReviewItems(items, currentUserIdRef.current);
      if (serverItems.length === 0) return;
      syncGenerationRef.current++;
      await saveItems(serverItems);
      markItemsSynced(new Set(serverItems.map(item => item.data.id)));
    } catch (error) {
      logError(`${label}: immediate server sync failed`, error);
    }
  };

  // Throttle localStorage writes during rapid SRS updates (e.g. reviewing 20+ cards)
  const srsSavePendingRef = useRef(false);
  const srsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  
  // Keep latestItemsRef in sync with state (synchronously, so event handlers always have current data)
  useEffect(() => {
    latestItemsRef.current = syncState.items;
  }, [syncState.items]);

  // Projects
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null); // null = show all
  const didInitDefaultProjectRef = useRef(false); // ensures the default-project landing runs once per session

  const projectsCacheKey = authState.user ? `vps_projects_cache_${authState.user.id}` : 'vps_projects_cache';

  // setProjects + write-through to localStorage so the next page load can render
  // them instantly instead of waiting on the network round-trip.
  const persistProjects = useCallback((p: ProjectInfo[]) => {
    setProjects(p);
    try {
      localStorage.setItem(projectsCacheKey, JSON.stringify(p));
    } catch (e) {
      warn("Failed to cache projects to localStorage", e);
    }
  }, [projectsCacheKey]);

  // Restore projects from localStorage cache once auth is resolved
  useEffect(() => {
    if (authState.loading || !authState.user) return;
    try {
      const cached = localStorage.getItem(projectsCacheKey);
      if (cached) {
        const cachedProjects = JSON.parse(cached);
        if (Array.isArray(cachedProjects) && cachedProjects.length > 0) {
          setProjects(cachedProjects);
        }
      }
    } catch (e) {
      warn("Failed to restore projects from cache", e);
    }
  }, [authState.loading, authState.user?.id, projectsCacheKey]);

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
    const apply = (items: StoredItem[]): StoredItem[] => items.map(local => {
      const serverItem = byId.get(local.data.id);
      if (!serverItem) return local;
      const reconciled: StoredItem = {
        ...local,
        srs: serverItem.srs,
        serverRevision: serverItem.serverRevision,
        updatedAt: Math.max(local.updatedAt || 0, serverItem.updatedAt || 0),
      };
      if (getItemContentHash(reconciled) === getItemContentHash(serverItem)) {
        reconciled.lastSyncedHash = getItemContentHash(reconciled);
      }
      return reconciled;
    });

    const nextItems = apply(latestItemsRef.current);
    latestItemsRef.current = nextItems;
    serverCursorRef.current = latestRevisionCursor([...nextItems, ...serverItems]);
    setSyncState(prevState => ({ ...prevState, items: apply(prevState.items) }));
    await saveItemUpdates(
      nextItems.filter(item => byId.has(item.data.id)),
      currentUserIdRef.current,
    );
  }, []);

  const flushPendingReviews = useCallback(async () => {
    const userId = authState.user?.id;
    if (!userId || !navigator.onLine) return;
    if (reviewFlushPromiseRef.current) return reviewFlushPromiseRef.current;
    const runFlush = async () => {
      try {
        for (;;) {
          const mutation = readPendingReviewMutations(userId)[0];
          if (!mutation) break;
          const response = await applyReviewMutation(mutation.event, mutation.itemIds);
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


  // Land on the default project (DEFAULT_PROJECT_NAME) once projects are known. Runs once per
  // session, so switching projects mid-session sticks; a fresh load returns to the default.
  useEffect(() => {
    if (didInitDefaultProjectRef.current) return;
    if (authState.loading || !authState.user || projects.length === 0) return;
    const def = projects.find(p => (p.name || '').trim().toLowerCase() === DEFAULT_PROJECT_NAME.toLowerCase());
    if (def) setActiveProject(def.id);
    didInitDefaultProjectRef.current = true;
  }, [authState.loading, authState.user?.id, projects]);

  // Derived state - memoized filtered items
  const savedItems = syncState.items;
  const allActiveItems = useMemo(() => savedItems.filter(i => !i.isDeleted && i.type !== 'sentence'), [savedItems]);
  // Variant-aware lookup index (base word + each inflected form → base word), rebuilt
  // only when items change. Powers "search a variant → pop up the saved card, skip AI".
  const variantIndex = useMemo(() => buildVariantIndex(allActiveItems), [allActiveItems]);
  // base word → its saved vocab item (most-reviewed sense), so footnote lookup is O(1) per word
  // instead of an O(n) scan over the whole library on every rendered token. See findSavedItem.
  const savedVocabByBase = useMemo(() => {
    const m = new Map<string, StoredItem>();
    for (const i of allActiveItems) {
      if (i.type !== 'vocab') continue;
      const base = normalizeKey((i.data as VocabCard).word || '');
      if (!base) continue;
      const prev = m.get(base);
      if (!prev || (i.srs?.totalReviews ?? 0) > (prev.srs?.totalReviews ?? 0)) m.set(base, i);
    }
    return m;
  }, [allActiveItems]);
  // Filter by project for notebook display (null = show all)
  const activeItems = useMemo(() => {
    if (!activeProject) return allActiveItems;
    return allActiveItems.filter(i => i.project === activeProject);
  }, [allActiveItems, activeProject]);
  // Items available for study — always all projects (excludes archived and sentences)
  const studyItems = useMemo(() => savedItems.filter(i => !i.isDeleted && !i.isArchived && i.type !== 'sentence'), [savedItems]);
  // Sentence items
  const sentenceItems = useMemo(() => savedItems.filter(i => !i.isDeleted && i.type === 'sentence'), [savedItems]);
  const sentenceDueCount = useMemo(() => {
    const now = Date.now();
    return sentenceItems.filter(s => !s.isArchived && ((s.srs?.nextReview ?? 0) <= now)).length;
  }, [sentenceItems]);
  
  // Start as "loaded" if we have cached items (instant UI)
  // Full data will be loaded from IndexedDB in background
  const [isLoaded, setIsLoaded] = useState(() => syncState.items.length > 0);
  const showNavRef = useRef(true);
  const navRef = useRef<HTMLElement>(null);
  const lastScrollYRef = useRef(0);
  
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
  const [detailContext, setDetailContext] = useState<{ groups: ItemGroup[], groupIndex: number, itemIndex: number, sentenceItems?: StoredItem[] } | null>(null);

  // Footnote card popup — keyed by the word's SPELLING (so deleting one sense doesn't lose the rest)
  // plus the sense to open on. popupItems = every saved sense of that word, for in-popup paging; it's
  // re-resolved live from allActiveItems so Got it / Reset / Delete update the card in place.
  const [cardPopup, setCardPopup] = useState<{ spelling: string; initialId: string } | null>(null);
  const openCardPopup = useCallback((it: StoredItem) => setCardPopup({ spelling: getItemSpelling(it), initialId: it.data.id }), []);
  const popupItems = useMemo(
    () => (cardPopup ? allActiveItems.filter(i => i.type === 'vocab' && getItemSpelling(i) === cardPopup.spelling) : []),
    [cardPopup, allActiveItems],
  );
  // Footnote popup: fetch a word's full set of AI senses (cached per session) so the popup can page
  // through saved + not-yet-saved meanings; and save a chosen sense (inheriting the word's project).
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
    const spelling = (vocab.word || '').toLowerCase().trim();
    const sib = latestItemsRef.current.find(i => !i.isDeleted && i.type === 'vocab' && getItemSpelling(i) === spelling);
    const project = sib?.project ?? activeProject ?? undefined;
    const v: VocabCard = { ...vocab, id: vocab.id || crypto.randomUUID() };
    handleSaveRef.current({ data: v, type: 'vocab', savedAt: Date.now(), srs: SRSAlgorithm.createNew(v.id, 'vocab'), ...(project ? { project } : {}) });
  }, [activeProject]);

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

  // Image backfill state — generates missing images for vocab cards that have an
  // imagePrompt but no imageUrl (typically from batch-imported items).
  const [imageBackfillProgress, setImageBackfillProgress] = useState<{
    current: number; total: number; succeeded: number; failed: number; isRunning: boolean;
  } | null>(null);
  const imageBackfillAbortRef = useRef(false);

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
      // Reload projects
      loadProjects().then(p => persistProjects(p)).catch(e => warn("Failed to load projects:", e));

      // 1. Pull latest items from server
      const remoteItems = await loadAllItems();
      serverCursorRef.current = latestRevisionCursor([...latestItemsRef.current, ...remoteItems]);

      // 2. Merge with latest state, strip images, then set state
      let mergedItems = cleanupOldDeletedItems(mergeDatasets(latestItemsRef.current, remoteItems));
      mergedItems = await stripAndStoreImages(mergedItems);
      latestItemsRef.current = mergedItems;
      setSyncState({ items: mergedItems });

      // 3. Push items that differ from remote
      const remoteHashMap = new Map<string, string>();
      remoteItems.forEach(item => {
        if (item.data?.id) remoteHashMap.set(item.data.id, getItemContentHash(item));
      });
      const changedItems: StoredItem[] = [];
      for (const item of mergedItems) {
        const mergedHash = getItemContentHash(item);
        const remoteHash = remoteHashMap.get(item.data.id);
        if (mergedHash === remoteHash) {
          item.lastSyncedHash = mergedHash;
        } else {
          changedItems.push(item);
        }
      }
      const forceSyncItems = excludePendingReviewItems(changedItems, currentUserIdRef.current);
      if (forceSyncItems.length > 0) {
        log(`Server: Force sync uploading ${forceSyncItems.length} changed items`);
        // Images are uploaded separately via the image endpoint; item PUTs carry no base64.
        await saveItems(forceSyncItems);
        for (const item of forceSyncItems) {
          item.lastSyncedHash = getItemContentHash(item);
        }
      }

      setSyncStatus('saved');

    } catch (e) {
      logError("Force Sync Failed:", e);
      setSyncStatus('error');
    } finally {
      forceSyncInProgressRef.current = false;
    }
  }, [flushPendingReviews]);

  // Save data before page unload (refresh, close tab, navigate away)
  // This is a critical safety net to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Use ref to get latest items (avoids stale closure)
      const currentItems = latestItemsRef.current;
      
      if (isLoaded && currentItems.length > 0) {
        // Skip if we just saved (within last 500ms) to avoid redundant writes
        const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
        if (timeSinceLastSave < 500) {
          log("💾 Skipping beforeunload save (recently saved)");
          return;
        }

        // Use synchronous localStorage as a backup (IndexedDB is async and may not complete)
        try {
          localStorage.setItem(cacheKey, JSON.stringify(createLightweightCache(currentItems)));
          log("💾 Saved items cache on beforeunload");
        } catch (e) {
          warn("Failed to save cache on beforeunload:", e);
        }
        // Also try IndexedDB (may not complete but worth trying)
        userSaveData(currentItems).catch(e => warn("Failed to save on beforeunload:", e));
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLoaded]);

  // Save data when app goes to background / returns from background
  useEffect(() => {
      const handleVisibilityChange = async () => {
          if (document.visibilityState === 'visible') {
              window.speechSynthesis?.cancel();
              const lastHiddenStr = localStorage.getItem('app_last_hidden');
              if (lastHiddenStr) {
                  const lastHidden = parseInt(lastHiddenStr, 10);
                  const now = Date.now();
                  if (now - lastHidden > 30 * 1000) {
                      log("🔄 App was backgrounded for >30s, syncing...");
                      handleForceSync();
                  }
              }
              localStorage.removeItem('app_last_hidden');
          } else {
              localStorage.setItem('app_last_hidden', Date.now().toString());

              const currentItems = latestItemsRef.current;

              if (srsSaveTimerRef.current) {
                clearTimeout(srsSaveTimerRef.current);
                srsSaveTimerRef.current = null;
                srsSavePendingRef.current = false;
              }

              const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
              if (timeSinceLastSave < 500) {
                  log("💾 Skipping visibility change save (recently saved)");
                  return;
              }

              if (isLoaded && currentItems.length > 0) {
                  log("💾 App going to background, saving data immediately...");
                  try {
                    localStorage.setItem(cacheKey, JSON.stringify(createLightweightCache(currentItems)));
                  } catch (e) {
                    warn("Failed to save cache on visibility change:", e);
                  }
                  userSaveData(currentItems).catch(e => {
                      warn("Failed to save on visibility change:", e);
                  });
                  // Best-effort server push
                  const changedItems: StoredItem[] = [];
                  for (const item of currentItems) {
                    const currentHash = getItemContentHash(item);
                    if (currentHash !== item.lastSyncedHash) {
                      changedItems.push(item);
                    }
                  }
                  const backgroundItems = excludePendingReviewItems(changedItems, currentUserIdRef.current);
                  if (backgroundItems.length > 0) {
                    log(`Server: Pushing ${backgroundItems.length} changed items on background...`);
                    saveItems(backgroundItems).then(() => {
                      for (const item of backgroundItems) {
                        item.lastSyncedHash = getItemContentHash(item);
                      }
                    }).catch(e => {
                      warn("Server push on background failed:", e);
                    });
                  }
              }
          }
      };

      const handleBeforeExternalNav = () => {
        const currentItems = latestItemsRef.current;
        if (!isLoaded || currentItems.length === 0) return;
        log("💾 Saving state before external navigation...");
        try {
          localStorage.setItem(cacheKey, JSON.stringify(createLightweightCache(currentItems)));
        } catch (e) {
          warn("Failed to save cache before external nav:", e);
        }
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
  }, [isLoaded, handleForceSync]);

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    if (!authState.user) return;
    const userId = authState.user.id;
    const initStorage = async () => {
        try {
            const migrated = await migrateFromLocalStorage();
            let itemsFromIDB: StoredItem[] = [];

            if (migrated && migrated.length > 0) {
                itemsFromIDB = migrated;
            } else {
                const items = await loadData(userId);
                if (items && Array.isArray(items)) {
                    itemsFromIDB = items.filter((i: any) =>
                        i && i.data && i.data.id && i.srs && i.type
                    );
                }
            }
            
            // IndexedDB is the source of truth (has full item data)
            // localStorage cache is now lightweight (titles + SRS only) for instant UI
            const cachedItems = latestItemsRef.current;
            let processedItems: StoredItem[];
            let needsSaveToIDB = false;

            if (itemsFromIDB.length > 0) {
                // The cache can contain a review written just before a reload while IndexedDB owns
                // full content. Merge both: cache learning timestamps win, IDB definitions remain.
                processedItems = cachedItems.length > 0
                    ? mergeDatasets(cachedItems, itemsFromIDB)
                    : itemsFromIDB;
                needsSaveToIDB = cachedItems.length > 0;
                log(`📦 Loaded ${processedItems.length} items from IndexedDB`);
            } else if (cachedItems.length > 0) {
                // IndexedDB empty, fall back to cache (lightweight, but better than nothing)
                // Save cache items to IDB so auth effect and future loads find them
                processedItems = cachedItems;
                needsSaveToIDB = true;
                log(`📦 IndexedDB empty, using cache: ${processedItems.length} items`);
            } else {
                processedItems = [];
            }
            
            let hasChanges = false;

            // 1. SRS Migration
            const needsSRSMigration = processedItems.some(item => typeof item.srs?.memoryStrength !== 'number');
            if (needsSRSMigration && processedItems.length > 0) {
                processedItems = processedItems.map(item => ({
                    ...item,
                    srs: SRSAlgorithm.migrate(item.srs)
                }));
                hasChanges = true;
            }

            // 2. Timestamp Fix (for Sync)
            const needsTimestampFix = processedItems.some(item => !item.updatedAt && !item.savedAt);
            if (needsTimestampFix) {
                const now = Date.now();
                processedItems = processedItems.map(item => {
                    if (!item.updatedAt && !item.savedAt) {
                        return { ...item, savedAt: now, updatedAt: now };
                    }
                    return item;
                });
                hasChanges = true;
            }

            // 3. A review mutation is written synchronously before the async IndexedDB journal. Reapply
            // those tiny patches here so an immediate refresh cannot roll progress back.
            processedItems = overlayPendingReviews(processedItems, readPendingReviewMutations(userId));

            // 3.5. Strip images from items → IDB (keep ~143MB out of React state)
            processedItems = await stripAndStoreImages(processedItems);

            // 4. Initialize sync state with merged data
            setSyncState({
                items: processedItems
            });

            // Also update the ref
            latestItemsRef.current = processedItems;
            serverCursorRef.current = latestRevisionCursor(processedItems);
            
            // 4. Save merged result back to IndexedDB if we merged or made changes
            // This ensures IndexedDB is up-to-date with any fresher data from cache
            if (hasChanges || needsSaveToIDB) {
                await saveData(processedItems, userId);
            }
        } catch (e) {
            logError("Failed to initialize storage", e);
        } finally {
            setIsLoaded(true);
        }
    };
    initStorage();
  }, [authState.user?.id]);

  // Cleanup old deleted items (hard delete after retention period)
  const cleanupOldDeletedItems = (items: StoredItem[]): StoredItem[] => {
    const DELETION_RETENTION_DAYS = 30; // Keep deleted items for 30 days for sync
    const retentionMs = DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    const cleaned = items.filter(item => {
      if (!item.isDeleted) return true; // Keep all active items
      
      const deletedAt = item.updatedAt || 0;
      const age = now - deletedAt;
      
      if (age > retentionMs) {
        return false; // Hard delete
      }
      
      return true; // Keep within retention period
    });
    
    return cleaned;
  };

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
    for (const item of candidates) {
      if (item.isDeleted || item.isArchived) continue;
      const data = item.data as any;
      if (isImageMarker(data.imageUrl)) idsWithImages.push(data.id);
      if (Array.isArray(data.vocabs)) {
        for (const v of data.vocabs) {
          if (isImageMarker(v.imageUrl)) idsWithImages.push(v.id);
        }
      }
    }
    if (idsWithImages.length === 0) return;

    // Check which IDs already have images in IDB
    const alreadyStored = await getStoredImageIds(idsWithImages);
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
        const images = await loadItemImagesBatch(batch);
        const toSave = Object.entries(images).map(([id, base64]) => ({ id, base64 }));
        if (toSave.length > 0) await saveImagesBatch(toSave);
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

  // 2. SERVER SYNC — pull from server on mount, merge with local
  useEffect(() => {
    const syncFromServer = async () => {
      try {
        await flushPendingReviews();
        // Load projects alongside items
        loadProjects().then(p => persistProjects(p)).catch(e => warn("Failed to load projects:", e));

        const remoteItems = await loadAllItems();
        serverCursorRef.current = latestRevisionCursor([...latestItemsRef.current, ...remoteItems]);
        if (remoteItems.length === 0) return;

        let mergedItems = mergeDatasets(latestItemsRef.current, remoteItems);
        mergedItems = cleanupOldDeletedItems(mergedItems);

        // Strip images before putting into React state
        mergedItems = await stripAndStoreImages(mergedItems);

        latestItemsRef.current = mergedItems;

        // Mark items matching remote as synced
        const remoteHashMap = new Map<string, string>();
        remoteItems.forEach(item => {
          if (item.data?.id) remoteHashMap.set(item.data.id, getItemContentHash(item));
        });
        const catchUpItems: StoredItem[] = [];
        mergedItems.forEach(item => {
          const mergedHash = getItemContentHash(item);
          const remoteHash = remoteHashMap.get(item.data.id);
          if (mergedHash === remoteHash) {
            item.lastSyncedHash = mergedHash;
          } else {
            catchUpItems.push(item);
          }
        });

        // Push items that differ from server
        const initialCatchUpItems = excludePendingReviewItems(catchUpItems, currentUserIdRef.current);
        if (initialCatchUpItems.length > 0) {
          log(`Server: ${initialCatchUpItems.length} items differ, uploading...`);
          // Images sync separately via the image endpoint; item PUTs carry no base64.
          saveItems(initialCatchUpItems).then(() => {
            for (const item of initialCatchUpItems) {
              item.lastSyncedHash = getItemContentHash(item);
            }
          }).catch(e => logError("Catch-up sync failed:", e));
        }

        setSyncState({ items: mergedItems });

        // Start background image pre-fetch after sync
        prefetchImages(mergedItems);
      } catch (error) {
        logError("Initial server sync failed:", error);
      } finally {
        initialServerSyncDoneRef.current = true;
      }
    };

    // Only sync after local data is loaded
    if (isLoaded) {
      syncFromServer();
    }
  }, [isLoaded, flushPendingReviews]);

  const deltaPullInProgressRef = useRef(false);
  const pullServerChanges = useCallback(async () => {
    if (!authState.user || !initialServerSyncDoneRef.current || deltaPullInProgressRef.current ||
        !navigator.onLine || document.visibilityState !== 'visible') return;
    deltaPullInProgressRef.current = true;
    try {
      await flushPendingReviews();
      let cursor = serverCursorRef.current;
      const remoteItems: StoredItem[] = [];
      for (;;) {
        const page = await loadItemChanges(cursor);
        remoteItems.push(...page.items);
        const advanced = page.cursor.revision > cursor.revision ||
          (page.cursor.revision === cursor.revision && page.cursor.id > cursor.id);
        cursor = page.cursor;
        if (!page.hasMore || !advanced) break;
      }
      serverCursorRef.current = cursor;
      if (remoteItems.length === 0) return;

      const remoteById = new Map(remoteItems.map(item => [item.data.id, item]));
      const mergeChanges = (base: StoredItem[]): StoredItem[] => {
        const merged = mergeDatasets(base, remoteItems);
        return merged.map(item => {
          const remote = remoteById.get(item.data.id);
          if (!remote || getItemContentHash(item) !== getItemContentHash(remote)) return item;
          return { ...item, lastSyncedHash: getItemContentHash(item) };
        });
      };
      const nextItems = mergeChanges(latestItemsRef.current);
      latestItemsRef.current = nextItems;
      setSyncState(prevState => ({ ...prevState, items: mergeChanges(prevState.items) }));
      await saveItemUpdates(
        nextItems.filter(item => remoteById.has(item.data.id)),
        authState.user.id,
      );
      log(`Server: pulled ${remoteItems.length} changed item(s)`);
    } catch (error) {
      warn('Background sync will retry:', error);
    } finally {
      deltaPullInProgressRef.current = false;
    }
  }, [authState.user?.id, flushPendingReviews]);

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

  // Cache items to localStorage for instant restoration on iOS PWA reload
  // Strip images to stay within 5MB localStorage limit
  // If full cache doesn't fit, progressively shrink: drop vocabs from phrases,
  // then truncate to most recently updated items
  useEffect(() => {
    if (!isLoaded || syncState.items.length === 0) return;

    // Skip if a throttled SRS save is pending (Fix 1A handles localStorage for SRS updates)
    if (srsSavePendingRef.current) return;

    // Debounce localStorage cache writes — localStorage is only an optimization for fast reload,
    // IDB is the real persistence layer, so a 5-second delay is safe
    const debounceTimer = setTimeout(() => {
      // Re-check in case SRS save started during the delay
      if (srsSavePendingRef.current) return;

      const fullCache = createLightweightCache(syncState.items);

    // Try full cache first
    try {
      localStorage.setItem(cacheKey, JSON.stringify(fullCache));
      return;
    } catch {
      // Full cache too large — try shrinking
    }

    // Strategy 1: Strip vocabs[] from phrase items (biggest payload)
    const slimCache = fullCache.map((entry: any) => {
      if (entry.type === 'phrase' && entry.data?.vocabs) {
        return { ...entry, data: { ...entry.data, vocabs: entry.data.vocabs.map((v: any) => ({ id: v.id, word: v.word, sense: v.sense })) } };
      }
      return entry;
    });
    try {
      localStorage.setItem(cacheKey, JSON.stringify(slimCache));
      return;
    } catch {
      // Still too large
    }

    // Strategy 2: Keep only SRS-essential fields, sorted by most recently updated
    const essentialCache = syncState.items
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(item => ({
        type: item.type,
        srs: item.srs,
        isDeleted: item.isDeleted || undefined,
        isArchived: item.isArchived || undefined,
        data: {
          id: item.data.id,
          ...(isPhraseItem(item)
            ? { query: item.data.query }
            : isSentenceItem(item)
              ? { text: item.data.text, sourceWord: item.data.sourceWord, sourceSense: item.data.sourceSense }
              : { word: getItemTitle(item), sense: getItemSense(item) }),
        },
      }));

    // Binary search for max items that fit
    let lo = 0, hi = essentialCache.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(essentialCache.slice(0, mid)));
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    if (lo > 0) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(essentialCache.slice(0, lo)));
      } catch {
        // Give up — keep whatever was in cache before
      }
    }
    warn(`localStorage cache truncated to ${lo}/${syncState.items.length} items`);
    }, 5000); // 5s debounce

    return () => clearTimeout(debounceTimer);
  }, [syncState.items, isLoaded]);

  // 3. SAVE EFFECTS (Persistence + Server Sync)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(async () => {
      const myGeneration = syncGenerationRef.current;
      const currentItems = latestItemsRef.current;

      // 1. Save to Local IDB
      const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
      if (timeSinceLastSave < 2000) {
        log("💾 Skipping debounced IDB save (recent immediate save)");
      } else {
        await userSaveData(currentItems);
      }

      // 2. Push dirty items to server
      // SAFETY: Never push skeleton cache items (missing content fields) to server.
      // The lightweight localStorage cache strips definition/history/examples to save space.
      // If these skeleton items end up in state, pushing them would overwrite full data on server.
      const hasFullContent = currentItems.some(item => {
        if (item.type === 'sentence') return true;
        const d = item.data as any;
        return !!(d.definition || d.history || d.grammar || (Array.isArray(d.examples) && d.examples.length > 0));
      });
      if (!hasFullContent && currentItems.length > 10) {
        log("⚠️ Skipping server sync — items appear to be skeleton cache data");
        return;
      }

      const itemsWithHashes: { item: StoredItem; hash: string }[] = [];
      currentItems.forEach(item => {
        const currentHash = getItemContentHash(item);
        if (currentHash === item.lastSyncedHash) return;
        itemsWithHashes.push({ item, hash: currentHash });
      });

      if (itemsWithHashes.length === 0) {
        setSyncStatus('saved');
        return;
      }

      setSyncStatus('syncing');
      log(`Server: ${itemsWithHashes.length} items changed, pushing...`);

      try {
        // Images sync separately via the image endpoint; item PUTs carry no base64.
        const itemsToSync = excludePendingReviewItems(
          itemsWithHashes.map(i => i.item),
          currentUserIdRef.current,
        );
        const syncedIds = new Set(itemsToSync.map(item => item.data.id));
        if (itemsToSync.length === 0) {
          setSyncStatus('idle');
          return;
        }

        // If an immediate sync (SRS/delete/archive) happened, our data is stale —
        // skip this push. Next debounce cycle will pick up.
        if (syncGenerationRef.current !== myGeneration) {
          log("⏭️ Skipping debounced push (immediate sync happened, next cycle will handle)");
          setSyncStatus('saved');
          return;
        }

        await saveItems(itemsToSync);

        for (const { item, hash } of itemsWithHashes) {
          if (syncedIds.has(item.data.id)) item.lastSyncedHash = hash;
        }

        lastSaveTimeRef.current = Date.now();
        await userSaveData(currentItems);

        setSyncStatus('saved');
      } catch (e) {
        logError("Sync error:", e);
        setSyncStatus('error');
      }

    }, 5000);

    return () => clearTimeout(timer);
  }, [syncState, isLoaded]);

  // Bulk refresh - actual execution
  const executeBulkRefresh = useCallback(async () => {
    setBulkRefreshProgress({ current: 0, total: activeItems.length, isRunning: true });

    // Group items by their title to avoid duplicate searches
    const titleMap = new Map<string, StoredItem[]>();
    activeItems.forEach(item => {
      const title = getItemTitle(item).toLowerCase().trim();
      if (!titleMap.has(title)) {
        titleMap.set(title, []);
      }
      titleMap.get(title)!.push(item);
    });

    const uniqueTitles = Array.from(titleMap.keys());
    let processed = 0;
    let errors = 0;

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
          setSyncState(prevState => {
            const index = prevState.items.findIndex(i => i.data.id === item.data.id);
            if (index >= 0) {
              const newItems = [...prevState.items];
              newItems[index] = {
                ...newItems[index],
                data: newData,
                type: item.type,
                updatedAt: Date.now()
              };
              return { ...prevState, items: newItems };
            }
            return prevState;
          });
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
  }, [activeItems]);

  // Bulk refresh - show confirmation first
  const handleBulkRefresh = useCallback(() => {
    if (activeItems.length === 0) {
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
      message: `This will re-search all ${activeItems.length} items in your notebook with the latest AI analysis.\n\nThis may take a while and use API quota.`,
      confirmText: 'Refresh All',
      cancelText: 'Cancel',
      variant: 'warning',
      onConfirm: () => {
        setConfirmModal(null);
        executeBulkRefresh();
      }
    });
  }, [activeItems, executeBulkRefresh]);

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
  // (run/running/ran), then open the review modal. Scans across ALL projects.
  const handleFindDuplicates = useCallback(() => {
    const clusters = findDuplicateClusters(allActiveItems);
    const detailed: DuplicateClusterView[] = clusters
      .map((baseWords, i) => {
        const set = new Set(baseWords);
        const clusterItems = allActiveItems.filter(
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
  }, [allActiveItems]);

  // Apply the user-confirmed merges: relabel to canonical, union forms, dedupe senses,
  // and push the changed items immediately (like delete/SRS paths).
  const handleMergeDuplicates = useCallback(async (merges: Array<{ baseWords: string[]; canonical: string }>) => {
    setDuplicateClusters(null);
    if (!merges || merges.length === 0) return;

    const before = new Map(latestItemsRef.current.map(it => [it.data.id, getItemContentHash(it)]));
    const newItems = applyMerges(latestItemsRef.current, merges);
    latestItemsRef.current = newItems;
    setSyncState(prev => ({ ...prev, items: applyMerges(prev.items, merges) }));

    const changed = excludePendingReviewItems(
      newItems.filter(it => before.get(it.data.id) !== getItemContentHash(it)),
      currentUserIdRef.current,
    );
    log(`🔀 Merge: ${changed.length} item(s) changed across ${merges.length} cluster(s)`);

    try {
      if (changed.length > 0) {
        syncGenerationRef.current++; // make any in-flight debounced push skip (data is now stale)
        await saveItems(changed);
        for (const it of changed) it.lastSyncedHash = getItemContentHash(it);
      }
    } catch (e) {
      logError('🔀 Merge: failed to sync to server:', e);
    }
  }, []);

  // ── Batch Import (background processing) ──────────────────────────────────

  const BATCH_CONCURRENCY = 5;

  // Refs for batch import to avoid stale closures
  const handleSaveRef = useRef<(item: StoredItem) => void>(() => {});
  const runImageBackfillRef = useRef<(itemIds?: string[]) => Promise<void>>(async () => {});

  const handleBatchImport = useCallback(async (words: string[], project?: string) => {
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
                  ...(project ? { project } : {}),
                };
                handleSaveRef.current(storedItem);
                saved++;
                importedItemIds.push(vocab.id);

                // Image generation runs as a separate phase after text analysis
                // completes — see runImageBackfillRef call below. Doing it here
                // floods the server and times out the analyzeInput requests.
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
          handleBatchImport(failedWords, project);
        }
      },
      showCancel: failedWords.length > 0,
      cancelText: 'Dismiss',
    });

    // Phase 2: backfill images AND pre-generate sentence audio for the items we just imported. Both
    // run in the background (after the text analysis is done) so the new words play instantly later.
    if (importedItemIds.length > 0) {
      runImageBackfillRef.current(importedItemIds).catch(e => warn('Post-batch image backfill failed:', e));
      runSpeechGenerationRef.current(importedItemIds, { silent: true }).catch(e => warn('Post-batch speech generation failed:', e));
    }
  }, []);

  // ── Image backfill ────────────────────────────────────────────────────────
  // Generates missing images for vocab cards that have an imagePrompt but no
  // imageUrl. Used both for explicit user action ("Generate missing images"
  // button) and for the post-batch-import sweep.

  const IMAGE_BACKFILL_CONCURRENCY = 2;

  const runImageBackfill = useCallback(async (itemIds?: string[]) => {
    const all = latestItemsRef.current;
    const candidates = itemIds
      ? all.filter(i => itemIds.includes(i.data.id))
      : all.filter(i => !i.isDeleted && !i.isArchived);

    type Target = { itemId: string; vocabId: string; prompt: string };
    const targets: Target[] = [];
    for (const item of candidates) {
      if (item.isDeleted) continue;
      if (isVocabItem(item)) {
        const v = item.data;
        if (v.imagePrompt && !v.imageUrl) {
          targets.push({ itemId: v.id, vocabId: v.id, prompt: v.imagePrompt });
        }
      } else if (isPhraseItem(item)) {
        for (const v of item.data.vocabs || []) {
          if (v.imagePrompt && !v.imageUrl) {
            targets.push({ itemId: item.data.id, vocabId: v.id, prompt: v.imagePrompt });
          }
        }
      }
    }
    if (targets.length === 0) {
      setImageBackfillProgress(null);
      return;
    }

    setImageBackfillProgress({ current: 0, total: targets.length, succeeded: 0, failed: 0, isRunning: true });
    imageBackfillAbortRef.current = false;

    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    let idx = 0;

    const processOne = async () => {
      while (idx < targets.length && !imageBackfillAbortRef.current) {
        const target = targets[idx++];
        try {
          const imageData = await generateIllustration(target.prompt, '16:9');
          if (imageData) {
            const item = latestItemsRef.current.find(i =>
              (isVocabItem(i) && i.data.id === target.itemId) ||
              (isPhraseItem(i) && i.data.id === target.itemId)
            );
            if (item) {
              let updated: StoredItem = item;
              if (isVocabItem(item) && item.data.id === target.vocabId) {
                updated = { ...item, data: { ...item.data, imageUrl: imageData } };
              } else if (isPhraseItem(item)) {
                updated = {
                  ...item,
                  data: {
                    ...item.data,
                    vocabs: item.data.vocabs.map(v =>
                      v.id === target.vocabId ? { ...v, imageUrl: imageData } : v
                    ),
                  },
                };
              }
              handleSaveRef.current(updated);
              succeeded++;
            } else {
              failed++;
            }
          } else {
            failed++;
          }
        } catch (e) {
          warn('Image backfill failed for', target.vocabId, e);
          failed++;
        }
        completed++;
        setImageBackfillProgress({ current: completed, total: targets.length, succeeded, failed, isRunning: true });
        await new Promise(r => setTimeout(r, 300));
      }
    };

    const workers = Array.from(
      { length: Math.min(IMAGE_BACKFILL_CONCURRENCY, targets.length) },
      () => processOne()
    );
    await Promise.all(workers);
    setImageBackfillProgress(null);
  }, []);

  // Wire up the ref so handleBatchImport (declared earlier with empty deps) can call it
  runImageBackfillRef.current = runImageBackfill;

  // User-initiated backfill: count missing items, confirm, then run. Scope is
  // current view (active project if filtered, else all items).
  const handleGenerateMissingImages = useCallback(() => {
    const items = latestItemsRef.current.filter(i => {
      if (i.isDeleted || i.isArchived) return false;
      if (activeProject) return i.project === activeProject;
      return true;
    });

    let missing = 0;
    for (const item of items) {
      if (isVocabItem(item)) {
        if (item.data.imagePrompt && !item.data.imageUrl) missing++;
      } else if (isPhraseItem(item)) {
        for (const v of item.data.vocabs || []) {
          if (v.imagePrompt && !v.imageUrl) missing++;
        }
      }
    }

    if (missing === 0) {
      setConfirmModal({
        isOpen: true,
        title: 'No Missing Images',
        message: activeProject
          ? 'Every item in this project already has an image.'
          : 'Every item already has an image.',
        confirmText: 'OK',
        variant: 'info',
        onConfirm: () => setConfirmModal(null),
        showCancel: false,
      });
      return;
    }

    const scopeLabel = activeProject
      ? `project "${projects.find(p => p.id === activeProject)?.name ?? '?'}"`
      : 'your notebook';
    const estSeconds = Math.ceil((missing * 5) / IMAGE_BACKFILL_CONCURRENCY);
    const estMin = Math.ceil(estSeconds / 60);

    setConfirmModal({
      isOpen: true,
      title: 'Generate Missing Images',
      message: `${missing} item${missing === 1 ? '' : 's'} in ${scopeLabel} are missing images. This will use ~${missing} image API call${missing === 1 ? '' : 's'} and take ~${estMin} min. Continue?`,
      confirmText: 'Generate',
      variant: 'info',
      onConfirm: () => {
        setConfirmModal(null);
        const itemIds = items
          .filter(i => {
            if (isVocabItem(i)) return i.data.imagePrompt && !i.data.imageUrl;
            if (isPhraseItem(i)) return (i.data.vocabs || []).some(v => v.imagePrompt && !v.imageUrl);
            return false;
          })
          .map(i => i.data.id);
        runImageBackfill(itemIds).catch(e => warn('Image backfill failed:', e));
      },
      showCancel: true,
    });
  }, [activeProject, projects, runImageBackfill]);

  const handleSave = (item: StoredItem) => {
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

      // Resolve title-based duplicates before offloading images. The saved item's
      // stable id is also the image key, so uploading under a transient AI id would
      // orphan the new image when the content is merged into an existing card.
      const incomingSense = isVocabItem(item) ? (item.data.sense || '') : '';
      const canonicalExisting = latestItemsRef.current.find(existing => {
        if (existing.data.id === item.data.id) return true;
        if (existing.type !== item.type || getItemSpelling(existing) !== incomingTitle) return false;
        return !isVocabItem(item) || (isVocabItem(existing) && (existing.data.sense || '') === incomingSense);
      });
      const canonicalItemId = canonicalExisting?.data.id || item.data.id;

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

      // Use functional update to avoid stale closure issues when saving multiple items quickly
      setSyncState(prevState => {
        // Check if item already exists
        // PRIORITY: Check by ID first
        let existingIndex = prevState.items.findIndex(i => i.data.id === item.data.id);
        
        // If not found by ID, check by Title AND Sense (for vocab items with multiple meanings)
        if (existingIndex === -1 && incomingTitle) {
            const incomingSense = isVocabItem(item) ? (item.data.sense || '') : '';
            
            existingIndex = prevState.items.findIndex(i => {
              if (i.type !== item.type) return false;
              const titleMatch = getItemSpelling(i) === incomingTitle;
              if (!titleMatch) return false;
              
              // For vocab items, also check if the sense matches
              // This allows saving multiple meanings of the same word
              if (isVocabItem(item) && isVocabItem(i)) {
                const existingSense = i.data.sense || '';
                return existingSense === incomingSense;
              }
              
              return true;
            });
        }

        if (existingIndex >= 0) {
          // Update existing item
          const existingItem = prevState.items[existingIndex];
          
          // FORCE keeping the existing ID to ensure consistency
          const idToUse = existingItem.data.id;

          // Merge SRS data
          // PRIORITY: Use the incoming SRS (itemToSave.srs) if available, as it likely contains updates (e.g. from DetailView)
          // Fallback to existing SRS only if incoming is missing
          const srsSource = itemToSave.srs || existingItem.srs;
          
          const mergedSrs = SRSAlgorithm.ensure(
            srsSource,
            idToUse,
            existingItem.type
          );
          // Ensure SRS has correct ID
          mergedSrs.id = idToUse;
          
          const mergedItem: StoredItem = {
            ...itemToSave,
            data: { ...itemToSave.data, id: idToUse }, // Keep existing ID
            savedAt: existingItem.savedAt || now,
            updatedAt: now,
            srs: mergedSrs
          };
          
          // Update items array directly
          const newItems = [...prevState.items];
          newItems[existingIndex] = mergedItem;
          
          const nextState = {
            ...prevState,
            items: newItems
          };
          latestItemsRef.current = newItems;
          return nextState;
        } else {
          // New item
          
          // Each meaning owns its own FSRS card. A newly saved sense must not inherit another
          // sense's difficulty, lapses, or due date just because the spelling matches.
          const normalizedSRS = SRSAlgorithm.ensure(itemToSave.srs, itemToSave.data.id, itemToSave.type);
          const finalItem = { 
            ...itemToSave, 
            srs: normalizedSRS,
            savedAt: now,
            updatedAt: now
          };
          
          const newItems = [finalItem, ...prevState.items];
          const nextState = {
            ...prevState,
            items: newItems
          };
          latestItemsRef.current = newItems;
          return nextState;
        }
      });
    } catch (err) {
      logError("Error during save operation:", err);
    }
  };

  const handleUpdateStoredItem = (item: StoredItem) => {
    const rawTitle = getItemTitle(item);
    const incomingTitle = String(rawTitle || '').toLowerCase().trim();
    if (!incomingTitle) return;

    // Offload any incoming images to IDB + server before updating state
    const incomingImages: Array<{ id: string; base64: string }> = [];
    const incomingImageUrl = getItemImageUrl(item);
    if (incomingImageUrl?.startsWith('data:image/')) {
      incomingImages.push({ id: item.data.id, base64: incomingImageUrl });
    }
    if (isPhraseItem(item) && item.data.vocabs) {
      for (const v of item.data.vocabs) {
        if (v.imageUrl?.startsWith('data:image/')) {
          incomingImages.push({ id: v.id, base64: v.imageUrl });
        }
      }
    }
    if (incomingImages.length > 0) void offloadImages(incomingImages);

    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const itemId = item.data.id;

      // Case 1: Direct match by ID (top-level items)
      const index = prevState.items.findIndex(i => i.data.id === itemId);
      if (index >= 0) {
        const existingItem = prevState.items[index];
        const newItems = [...prevState.items];

        // Merge: keep existing fields, update with new data
        // Replace base64 imageUrl with marker (actual data is in IDB)
        const mergedData = { ...existingItem.data, ...item.data };
        if ((mergedData as any).imageUrl?.startsWith('data:image/')) {
          (mergedData as any).imageUrl = IMAGE_IDB_MARKER;
        }
        newItems[index] = {
          ...existingItem,
          data: mergedData,
          updatedAt: Date.now()
        };

        return {
          ...prevState,
          items: newItems
        };
      }

      // Case 2: Check if this is a vocab inside a phrase item
      // Vocab images are generated separately and need to update the parent phrase
      if (item.type === 'vocab') {
        const vocabData = item.data as VocabCard;

        for (let i = 0; i < prevState.items.length; i++) {
          const stored = prevState.items[i];
          if (stored.type === 'phrase') {
            const phraseData = stored.data as SearchResult;
            const vocabIndex = (phraseData.vocabs || []).findIndex(v => v.id === itemId);

            if (vocabIndex >= 0) {
              // Found the vocab inside this phrase - update it
              const newVocabs = [...(phraseData.vocabs || [])];
              const mergedVocab = { ...newVocabs[vocabIndex], ...vocabData };
              if (mergedVocab.imageUrl?.startsWith('data:image/')) {
                mergedVocab.imageUrl = IMAGE_IDB_MARKER;
              }
              newVocabs[vocabIndex] = mergedVocab;

              const newItems = [...prevState.items];
              newItems[i] = {
                ...stored,
                data: {
                  ...phraseData,
                  vocabs: newVocabs
                },
                updatedAt: Date.now()
              };

              return {
                ...prevState,
                items: newItems
              };
            }
          }
        }
      }

      return prevState;
    });
  };

  // Keep batch import refs up to date
  handleSaveRef.current = handleSave;

  /**
   * Lazy load image from server via dedicated binary endpoint.
   * Returns base64 data URI directly (no polling needed).
   * Also saves to IDB for offline access.
   */
  // Items we've already tried to regenerate a lost image for this session — so a failed regen (or a
  // promptless item) doesn't re-trigger costly generation on every swipe past it.
  const regenAttemptedRef = useRef<Set<string>>(new Set());

  const handleLazyLoadImage = useCallback(async (itemId: string): Promise<string | null> => {
    // 1) Server has it? loadItemImage THROWS on a transient failure (OfflineImage retries) and returns
    //    null only for a genuine 404 (the image is truly gone). Persist a hit to IDB for instant replay.
    const existing = await loadItemImage(itemId);
    if (existing) {
      try { await saveImage(itemId, existing); } catch { /* cache write is best-effort */ }
      log(`🖼️ Lazy-loaded image from server for: ${itemId}`);
      return existing;
    }

    // 2) Truly lost (404) — regenerate ONCE per session from the item's saved prompt, then persist it
    //    back to the server (so it isn't lost again) + IDB, and return it so the card shows immediately.
    if (regenAttemptedRef.current.has(itemId)) return null;
    regenAttemptedRef.current.add(itemId);
    let prompt: string | undefined;
    for (const it of latestItemsRef.current) {
      if (isVocabItem(it)) {
        if (it.data.id === itemId) { prompt = it.data.imagePrompt; break; }
      } else if (isPhraseItem(it)) {
        if (it.data.id === itemId) { prompt = it.data.visualKeyword || it.data.query; break; }
        const v = it.data.vocabs?.find((vv) => vv.id === itemId);
        if (v) { prompt = v.imagePrompt; break; }
      }
    }
    if (!prompt) return null; // nothing to regenerate from → placeholder
    log(`🖼️ Image lost for ${itemId} — regenerating from prompt`);
    const regenerated = await generateIllustration(prompt, '16:9');
    if (!regenerated) return null;
    const { optimizeImageDataUri } = await import('./services/imageProcessing');
    const optimized = await optimizeImageDataUri(regenerated);
    try { await saveImage(itemId, optimized); } catch { /* best-effort */ }
    try { await uploadImages({ [itemId]: optimized }); } catch (e) { warn('Failed to persist regenerated image:', e); }
    return optimized;
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

    const now = Date.now();

    // Update latestItemsRef IMMEDIATELY (before state update settles) so the
    // debounced IDB save and any concurrent reads see the deletion right away.
    // This prevents the bug where IDB saves the non-deleted version, which then
    // resurrects the item on next app load via merge.
    const refIndex = latestItemsRef.current.findIndex(i => i.data.id === id);
    let itemWithDelete: StoredItem | null = null;
    if (refIndex >= 0) {
      const newItems = [...latestItemsRef.current];
      itemWithDelete = { ...newItems[refIndex], isDeleted: true, updatedAt: now };
      newItems[refIndex] = itemWithDelete;
      latestItemsRef.current = newItems;
    }

    // Also update React state
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isDeleted: true,
          updatedAt: now
        };

        return {
          ...prevState,
          items: newItems
        };
      }
      warn('🗑️ App: Item not found for deletion:', id);
      return prevState;
    });

    // Update carousel immediately so card disappears instantly. Call both removers — each is a
    // no-op for the other mode (word id vs sentence id), so handleDelete stays mode-agnostic.
    removeItemFromDetailContext(id);
    removeSentenceFromDetailContext(id);

    // Immediately sync deletion to server (don't wait for 5s debounce)
    if (itemWithDelete) {
      log('🗑️ App: Immediately persisting deletion');
      await persistChangedItems([itemWithDelete], 'Delete');
    }
  }, []);

  const handleArchive = useCallback(async (id: string) => {
    log('📦 App: Archiving item', id);
    
    const now = Date.now();
    
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isArchived: true,
          updatedAt: now
        };
        
        return {
          ...prevState,
          items: newItems
        };
      }
      warn('📦 App: Item not found for archiving:', id);
      return prevState;
    });

    // Update the carousel immediately, before the server sync finishes.
    removeItemFromDetailContext(id);

    // Immediately sync archive to server
    const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
    if (itemToSync) {
      const itemWithArchive = { ...itemToSync, isArchived: true, updatedAt: now };
      await persistChangedItems([itemWithArchive], 'Archive');
    }
  }, []);

  const handleRemoveVocabFromPhrase = useCallback(async (phraseId: string, vocabId: string) => {
    log('🗑️ App: Removing vocab', vocabId, 'from phrase', phraseId);

    const now = Date.now();

    // Update ref immediately
    const refIndex = latestItemsRef.current.findIndex(i => i.data.id === phraseId);
    let updatedItem: StoredItem | null = null;
    if (refIndex >= 0) {
      const phrase = latestItemsRef.current[refIndex];
      const phraseData = phrase.data as any;
      if (Array.isArray(phraseData.vocabs) && phraseData.vocabs.length > 1) {
        const newVocabs = phraseData.vocabs.filter((v: any) => v.id !== vocabId);
        updatedItem = {
          ...phrase,
          data: { ...phraseData, vocabs: newVocabs },
          updatedAt: now,
        };
        const newItems = [...latestItemsRef.current];
        newItems[refIndex] = updatedItem;
        latestItemsRef.current = newItems;
      }
    }

    if (!updatedItem) return;

    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === phraseId);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = updatedItem!;
        return { ...prevState, items: newItems };
      }
      return prevState;
    });

    // Sync to server
    await persistChangedItems([updatedItem], 'Remove vocab');
  }, []);

  const handleUnarchive = useCallback(async (id: string) => {
    log('📦 App: Unarchiving item', id);
    
    const now = Date.now();
    
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isArchived: false,
          updatedAt: now
        };
        
        return {
          ...prevState,
          items: newItems
        };
      }
      return prevState;
    });
    
    // Immediately sync unarchive to server
    const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
    if (itemToSync) {
      const itemWithUnarchive = { ...itemToSync, isArchived: false, updatedAt: now };
      await persistChangedItems([itemWithUnarchive], 'Unarchive');
    }
  }, []);

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
  const handleSaveSentence = useCallback((text: string, sourceWord: string, sourceSense?: string) => {
    const sentenceData: SentenceData = {
      id: crypto.randomUUID(),
      text,
      sourceWord,
      sourceSense,
    };
    handleSave({
      data: sentenceData,
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(sentenceData.id, 'sentence'),
    });
  }, []);

  const isSentenceSaved = useCallback((text: string) => {
    return sentenceItems.some(s => (s.data as SentenceData).text === text);
  }, [sentenceItems]);

  const isVocabSaved = useCallback((vocab: VocabCard) => {
    const vocabWord = (vocab.word || '').toLowerCase().trim();
    return activeItems.some(i => {
      if (i.type !== 'vocab') return false;
      const savedWord = ((i.data as VocabCard).word || '').toLowerCase().trim();
      const savedSense = (i.data as VocabCard).sense || '';
      return savedWord === vocabWord && savedSense === vocab.sense;
    });
  }, [activeItems]);

  // Global lookup across ALL projects (not just the active one) so searching a saved word
  // — OR any inflected variant of it (running→run, cats→cat, happier→happy) — pops up the
  // existing card instead of re-running an AI search. Variant matching is via variantIndex
  // (forms + conservative lemmatiser; see services/wordMatch). isVocabSaved stays exact and
  // active-project scoped so the popup's Save button can still re-file it into the current project.
  const findSavedByWord = useCallback((word: string): VocabCard[] => {
    const bases = matchBaseWords(word, variantIndex);
    if (bases.size === 0) return [];
    return allActiveItems
      .filter(i => i.type === 'vocab' && bases.has(normalizeKey((i.data as VocabCard).word || '')))
      .map(i => i.data as VocabCard);
  }, [allActiveItems, variantIndex]);

  // Footnote lookup: the saved item (vocab or phrase) a sentence term maps to, or null. Variant-aware
  // for vocab (running→run etc.) via variantIndex; exact normalized match for phrases. Picks the
  // most-reviewed vocab sense so the popup's SRS bar is the meaningful one. Searches ALL projects.
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
  // its existing SRS), so spaced-repetition progress survives the refresh; meanings the refresh dropped
  // are deleted; brand-new meanings are added. Called again as illustrations stream in (see GlobalSearch).
  const handleRefreshReplace = useCallback((word: string, vocabs: VocabCard[]) => {
    if (!vocabs?.length) return;
    const spelling = word.toLowerCase().trim();
    const oldItems = latestItemsRef.current.filter(i =>
      !i.isDeleted && isVocabItem(i) && getItemSpelling(i) === spelling
    );
    const newSenses = new Set(vocabs.map(v => v.sense || ''));
    oldItems.forEach(o => {
      if (!newSenses.has((o.data as VocabCard).sense || '')) handleDelete(o.data.id); // meaning dropped by refresh
    });
    const projectOf = oldItems[0]?.project; // new meanings inherit the word's project
    vocabs.forEach(vocab => {
      const match = oldItems.find(o => ((o.data as VocabCard).sense || '') === (vocab.sense || ''));
      if (match) {
        // Update IN PLACE: keep the saved item's id/srs/savedAt/project, swap in the fresh content.
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
          ...(projectOf ? { project: projectOf } : {}),
        });
      }
    });
  }, [handleDelete]);

  const handleGeneratedImage = useCallback((vocab: VocabCard) => {
    const updated = mergeGeneratedVocabIntoStoredItem(latestItemsRef.current, vocab);
    if (updated) handleSaveRef.current(updated);
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
  // across ALL projects (allActiveItems), falling back to a synthetic minimal card (showing the
  // sentence as its sole example) when the source word no longer exists.
  const handleViewSentence = useCallback((ordered: StoredItem[], index: number) => {
    if (ordered.length === 0) return;
    const groups: ItemGroup[] = ordered.map(s => {
      const d = s.data as SentenceData;
      const w = (d.sourceWord || '').toLowerCase().trim();
      const matches = allActiveItems.filter(i => i.type === 'vocab' && getItemSpelling(i) === w);
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
  }, [allActiveItems]);

  // Reset only this sense/item. Different meanings now keep independent FSRS schedules.
  const resetSRS = useCallback((id: string) => {
    const target = latestItemsRef.current.find(i => i.data.id === id);
    if (!target) return;
    handleSaveRef.current({ ...target, srs: SRSAlgorithm.createNew(target.data.id, target.type) });
  }, []);

  // SRS update for one sense/item. The server applies the same FSRS transition atomically.
  //
  // The update is computed OUTSIDE setSyncState, from latestItemsRef.current (the app's
  // synchronously-maintained source of truth), so the immediate IndexedDB save + server push always
  // use the freshly-computed result. The previous version computed the result INSIDE the setState
  // updater and read it back through a ref on the next line — but React only runs that updater
  // synchronously via its "eager state" optimization, which it SKIPS whenever a syncState update is
  // already pending (a background sync, image streaming in, a prior review still committing…). In that
  // case the post-setState read got STALE data: the review landed in memory (the UI showed it) but the
  // immediate IDB/server writes missed it, so progress vanished on refresh or on another device. This
  // structure (compute → apply to ref → apply the same pure transform inside setState) removes the race
  // and mirrors handleMergeDuplicates above.
  const updateSRS = async (
    itemId: string,
    rating: ReviewRating = 'good',
    context?: { taskType?: ReviewTaskType; durationMs?: number; sessionId?: string; eventId?: string },
  ): Promise<boolean> => {
    const now = Date.now();

    const baseItems = latestItemsRef.current;
    const targetItem = baseItems.find(i => i.data.id === itemId);
    if (!targetItem) return false;

    const targetTitle = getItemTitle(targetItem).toLowerCase().trim();
    const idsToUpdate = new Set<string>([itemId]);
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

    // Pure transform, applied to BOTH the ref (fresh source for concurrent handlers) and — defensively —
    // to prevState inside setSyncState, so a concurrent update can't drop the change.
    const applySrs = (items: StoredItem[]): StoredItem[] => items.map(item =>
      idsToUpdate.has(item.data.id)
        ? { ...item, srs: { ...updatedSRS, id: item.data.id }, updatedAt: now }
        : item
    );

    const newItems = applySrs(baseItems);
    const itemsToSync = newItems.filter(item => idsToUpdate.has(item.data.id));
    const reviewMutation: PendingReviewMutation = {
      event: reviewEvent,
      itemIds: [...idsToUpdate],
      optimisticSrs: Object.fromEntries(itemsToSync.map(item => [item.data.id, item.srs])),
    };

    // The small localStorage outbox is synchronous and lands before React or IndexedDB work. Its
    // idempotent event id is the crash/reload boundary for offline and rapid reviews.
    enqueuePendingReviewMutation(authState.user?.id || 'vps', reviewMutation);
    recordReview(reviewEvent, { persist: false });
    syncGenerationRef.current++;
    latestItemsRef.current = newItems;
    setSyncState(prevState => ({ ...prevState, items: applySrs(prevState.items) }));

    // CRITICAL: save to IndexedDB immediately (primary persistence — never lose progress on a quick
    // refresh / app switch). Throttle the lightweight localStorage cache write during rapid reviews.
    srsSavePendingRef.current = true;
    if (!srsSaveTimerRef.current) {
      srsSaveTimerRef.current = setTimeout(() => {
        srsSaveTimerRef.current = null;
        srsSavePendingRef.current = false;
        try {
          localStorage.setItem(cacheKey, JSON.stringify(createLightweightCache(latestItemsRef.current)));
        } catch (e) {
          warn("Failed to update cache after SRS:", e);
        }
      }, 3000);
    }
    try {
      await saveItemUpdates(itemsToSync, authState.user?.id || 'vps');
      lastSaveTimeRef.current = Date.now();
      log(`💾 Immediately journaled ${itemsToSync.length} SRS update(s) to IndexedDB`);
    } catch (e) {
      logError('💾 Failed to save SRS update to IndexedDB:', e);
    }

    await flushPendingReviews();
    const userId = authState.user?.id || 'vps';
    return !readPendingReviewMutations(userId).some(mutation => mutation.event.id === reviewEvent.id);
  };

  // Handle scroll to hide/show nav bar — uses direct DOM mutation to avoid re-rendering App
  const handleScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    let shouldShow = showNavRef.current;

    if (currentScrollY < 10) {
      shouldShow = true;
    } else if (currentScrollY > lastScrollYRef.current && currentScrollY > 100) {
      shouldShow = false;
    } else if (currentScrollY < lastScrollYRef.current) {
      shouldShow = true;
    }

    if (shouldShow !== showNavRef.current) {
      showNavRef.current = shouldShow;
      if (navRef.current) {
        navRef.current.classList.toggle('translate-y-full', !shouldShow);
        navRef.current.classList.toggle('translate-y-0', shouldShow);
      }
    }

    lastScrollYRef.current = currentScrollY;
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

      {/* Global, always-visible TTS sweep progress — shows on every tab/view while generating. */}
      {ttsGenProgress?.isRunning && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[80] bg-indigo-600 text-white rounded-full shadow-xl px-4 py-2 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
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
        <ErrorBoundary
          onReset={() => setDetailContext(null)}
          fallbackMessage="Something went wrong displaying this card. Your data is safe — returning to notebook."
        >
          <DetailView
              groups={detailContext.groups}
              initialGroupIndex={detailContext.groupIndex}
              initialItemIndex={detailContext.itemIndex}
              sentenceItems={detailContext.sentenceItems?.map(s => {
                // Refresh each snapshot sentence with its LIVE saved copy (fresh SRS) so remembering
                // actually shows/records progress. detailContext.sentenceItems is frozen at open time and
                // never sees updateSRS bumps; sentences also aren't in activeItems (no project), so the
                // live source is the project-independent `sentenceItems` memo. Order preserved; a
                // since-deleted sentence falls back to its snapshot (deletion is handled separately).
                return sentenceItems.find(li => li.data.id === s.data.id) ?? s;
              })}
              onClose={() => setDetailContext(null)}
              onSave={handleSave}
              onDelete={handleDelete}
              onArchive={handleArchive}
              savedItems={activeItems}
              onSearch={handleRecursiveSearch}
              onRefresh={handleRefreshViaGlobal}
              onLazyLoadImage={handleLazyLoadImage}
              onUpdateSRS={updateSRS}
              onCompare={handleCompare}
              comparisons={comparisons}
              onOpenComparison={handleOpenComparison}
              onSaveSentence={handleSaveSentence}
              isSentenceSaved={isSentenceSaved}
              onRemoveVocabFromPhrase={handleRemoveVocabFromPhrase}
              findSaved={findSavedItem}
              onOpenCard={openCardPopup}
              interactionLocked={!!cardPopup}
              onAttachImage={handleAttachSentenceImage}
          />
        </ErrorBoundary>
      )}

      {popupItems.length > 0 && cardPopup && (
          <CardReviewPopup
              key={cardPopup.spelling}
              items={popupItems}
              initialId={cardPopup.initialId}
              onClose={() => setCardPopup(null)}
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
      )}
      </Suspense>

      <main className="flex-1 relative w-full min-h-0 overflow-hidden">
        <Suspense fallback={<div className="h-full grid place-items-center"><Loader2 className="animate-spin text-indigo-500" /></div>}>
        {currentView === 'notebook' && (
          <NotebookView
            items={activeItems}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onViewDetail={handleViewStoredItem}
            user={authState.user ? { uid: authState.user.id, displayName: authState.user.displayName, photoURL: authState.user.photoUrl, email: authState.user.email } : null}
            onSignIn={loginRedirect}
            onSignOut={logout}
            syncStatus={syncStatus}
            onScroll={handleScroll}
            onForceSync={handleForceSync}
            isOnline={isOnline}
            onBulkRefresh={handleBulkRefresh}
            bulkRefreshProgress={bulkRefreshProgress}
            hasSavedVariant={hasSavedVariant}
            onFindDuplicates={handleFindDuplicates}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onSave={handleSave}
            onUpdateStoredItem={handleUpdateStoredItem}
            onCompare={handleCompare}
            onSaveSentence={handleSaveSentence}
            isSentenceSaved={isSentenceSaved}
            hasOverlay={!!detailContext || !!confirmModal || showKeyboardHelp || !!cardPopup}
            projects={projects}
            activeProject={activeProject}
            onSetActiveProject={setActiveProject}
            onProjectsChanged={(p) => persistProjects(p)}
            allItems={allActiveItems}
            onBatchImport={handleBatchImport}
            onJSONImported={handleForceSync}
            batchImportProgress={batchImportProgress}
            onGenerateMissingImages={handleGenerateMissingImages}
            imageBackfillProgress={imageBackfillProgress}
            onGenerateAllSpeech={handleGenerateAllSpeech}
            ttsGenProgress={ttsGenProgress}
            onRestoreImagesToServer={handleRestoreImagesToServer}
            imageRestoreRunning={imageRestoreProgress !== null}
            onDownloadOfflineImages={handleDownloadOfflineImages}
          />
        )}

        {currentView === 'study' && (
          <StudyEnhanced
            items={studyItems}
            reviewEvents={reviewEvents}
            onReview={updateSRS}
            onUndoReview={undoSRSReview}
            onScroll={handleScroll}
          />
        )}

        {currentView === 'sentences' && (
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
        )}

        </Suspense>
      </main>

      <Suspense fallback={null}>
      <GlobalSearch
        onSave={handleSave}
        isVocabSaved={isVocabSaved}
        findSavedByWord={findSavedByWord}
        onSearch={handleRecursiveSearch}
        isOnline={isOnline}
        activeProject={activeProject || undefined}
        onLazyLoadImage={handleLazyLoadImage}
        onRefreshReplace={handleRefreshReplace}
        onGeneratedImage={handleGeneratedImage}
        onSaveSentence={handleSaveSentence}
        isSentenceSaved={isSentenceSaved}
        onCompareReady={handleCompareReady}
        onCompare={handleCompare}
        sentenceItems={sentenceItems}
        onOpenSentence={handleViewSentence}
      />
      </Suspense>

      <nav ref={navRef} className="fixed bottom-0 left-0 right-0 bg-white flex justify-between px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 z-30 transition-transform duration-300 translate-y-0">
        <NavButton view="notebook" currentView={currentView} onClick={setCurrentView} icon={Book} label="Notebook" />
        <NavButton view="sentences" currentView={currentView} onClick={setCurrentView} icon={MessageSquareQuote} label="Sentences" badge={sentenceDueCount || undefined} />
        <NavButton view="study" currentView={currentView} onClick={setCurrentView} icon={BrainCircuit} label="Study" />
        {/* Keyboard shortcuts hint - only visible on desktop */}
        <button 
          onClick={() => setShowKeyboardHelp(true)}
          className="hidden md:flex flex-col items-center justify-center py-3 gap-1 text-slate-300 hover:text-slate-500 transition-colors"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard size={20} strokeWidth={2} />
          <span className="text-[10px] font-bold uppercase tracking-wider">?</span>
        </button>
      </nav>

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
