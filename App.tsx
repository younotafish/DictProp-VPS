import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NotebookView } from './views/Notebook';
import { StudyEnhanced } from './views/StudyEnhanced';
import { SentencesView } from './views/SentencesView';
import { DetailView } from './views/DetailView';
import { ComparisonView } from './views/ComparisonView';
import { StoredItem, ViewState, SyncStatus, SyncState, SRSData, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, VocabCard, SearchResult, SentenceData, ItemGroup, isPhraseItem, isVocabItem } from './types';
import { Book, BrainCircuit, Keyboard, MessageSquareQuote } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage, saveImagesBatch, saveImage, rehydrateImagesForSync } from './services/storage';
import { mergeDatasets } from './services/sync';
import { loadAllItems, saveItems, loadSingleItem, getItemContentHash, analyzeInput } from './services/api';
import { checkAuth, loginRedirect, logout, AuthState } from './services/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConfirmModal } from './components/ConfirmModal';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { useGlobalNavigation } from './hooks';
import { log, warn, error as logError } from './services/logger';

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
    };
    if (item.isDeleted) entry.isDeleted = true;
    if (item.isArchived) entry.isArchived = true;

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
    } else {
      const vocab = item.data as VocabCard;
      entry.data = {
        id: vocab.id, word: vocab.word, sense: vocab.sense,
        chinese: vocab.chinese, ipa: vocab.ipa,
      };
    }
    return entry;
  });

// Normalize shared SRS: ensure all items with the same spelling share one SRS score.
// When siblings have drifted (sync, legacy data), picks the most recently reviewed sibling
// as canonical and applies its SRS to all others. Returns original array if nothing changed.
function normalizeSharedSRS(items: StoredItem[]): StoredItem[] {
  const groups = new Map<string, StoredItem[]>();
  items.forEach(item => {
    if (item.isDeleted) return;
    const spelling = getItemSpelling(item);
    if (!spelling) return;
    if (!groups.has(spelling)) groups.set(spelling, []);
    groups.get(spelling)!.push(item);
  });

  const updates = new Map<string, SRSData>();
  groups.forEach(siblings => {
    if (siblings.length <= 1) return;
    // Pick the most ADVANCED sibling as canonical (highest totalReviews).
    // Tiebreaker: most recent lastReviewDate. Prefer active (non-archived) siblings.
    // This prevents un-reviewed items (which have lastReviewDate set to creation time)
    // from becoming canonical and regressing reviewed siblings to "due" status.
    const activeSiblings = siblings.filter(s => !s.isArchived);
    const candidatePool = activeSiblings.length > 0 ? activeSiblings : siblings;
    const canonical = candidatePool.reduce((best, s) => {
      const bReviews = best.srs?.totalReviews || 0;
      const sReviews = s.srs?.totalReviews || 0;
      if (sReviews !== bReviews) return sReviews > bReviews ? s : best;
      // Tiebreaker: most recent lastReviewDate
      const bDate = best.srs?.lastReviewDate || 0;
      const sDate = s.srs?.lastReviewDate || 0;
      return sDate > bDate ? s : best;
    });
    const canonicalSRS = SRSAlgorithm.ensure(canonical.srs, canonical.data.id, canonical.type);
    for (const s of siblings) {
      if (s.data.id === canonical.data.id) continue;
      const sReviews = s.srs?.totalReviews || 0;
      const sDate = s.srs?.lastReviewDate || 0;
      // Detect drift using raw values (not ensure/migrate which can inject Date.now())
      if (sReviews !== canonicalSRS.totalReviews || sDate !== canonicalSRS.lastReviewDate) {
        updates.set(s.data.id, { ...canonicalSRS, id: s.data.id });
      }
    }
  });

  if (updates.size === 0) return items;
  return items.map(item => {
    const newSRS = updates.get(item.data.id);
    return newSRS ? { ...item, srs: newSRS } : item;
  });
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
    log(`🖼️ Offloading ${imagesToSave.length} images to IDB`);
    await saveImagesBatch(imagesToSave);
  }

  return stripped;
}

// Keyboard shortcut display component
const DETAIL_CONTEXT_KEY = 'app_detail_context';

const ShortcutRow: React.FC<{ keys: string[], description: string }> = ({ keys, description }) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="text-sm text-slate-600">{description}</span>
    <div className="flex items-center gap-1">
      {keys.map((key, i) => (
        <React.Fragment key={i}>
          <kbd className="min-w-[24px] h-6 px-1.5 bg-slate-100 border border-slate-200 rounded text-xs font-mono font-medium text-slate-700 flex items-center justify-center shadow-sm">
            {key}
          </kbd>
          {i < keys.length - 1 && <span className="text-slate-300 text-xs">+</span>}
        </React.Fragment>
      ))}
    </div>
  </div>
);

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
  
  // Restore from localStorage cache once auth is resolved
  useEffect(() => {
    if (authState.loading || !authState.user) return;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const items = JSON.parse(cached);
        if (Array.isArray(items) && items.length > 0) {
          log(`⚡ Instant restore: ${items.length} items from cache`);
          setSyncState({ items });
          setIsLoaded(true);
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

  // Ref to track the latest items - avoids stale closure issues in event handlers
  // This is updated synchronously whenever syncState changes
  const latestItemsRef = useRef<StoredItem[]>(syncState.items);
  
  // Track when we last saved to avoid redundant saves from event handlers
  const lastSaveTimeRef = useRef<number>(0);

  // Throttle localStorage writes during rapid SRS updates (e.g. reviewing 20+ cards)
  const srsSavePendingRef = useRef(false);
  const srsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  
  // Keep latestItemsRef in sync with state (synchronously, so event handlers always have current data)
  useEffect(() => {
    latestItemsRef.current = syncState.items;
  }, [syncState.items]);

  // Derived state - memoized filtered items
  const savedItems = syncState.items;
  const activeItems = useMemo(() => savedItems.filter(i => !i.isDeleted && i.type !== 'sentence'), [savedItems]);
  // Items available for study (excludes archived and sentences)
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
  const [showNav, setShowNav] = useState(true);
  const lastScrollYRef = useRef(0);
  
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');

  // Auth is required — app gates on authState below

  // Updated DetailContext to support Group-based navigation (2D: Groups vs Items)
  // NOTE: We no longer restore detailContext from localStorage. Persisted groups
  // can contain stale/corrupted StoredItem data that crashes DetailView on reload.
  // The trade-off is minor: users return to the notebook after a reload instead of
  // resuming exactly where they were in the detail view.
  const [detailContext, setDetailContext] = useState<{ groups: ItemGroup[], groupIndex: number, itemIndex: number } | null>(null);

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

  // Word comparison mode — 2-3 words to compare side-by-side
  const [comparisonWords, setComparisonWords] = useState<string[] | null>(null);
  
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
    enabled: !detailContext && !confirmModal && !showKeyboardHelp && !comparisonWords, // Disable when modals are open
  });

  // Global Escape key to close modals or go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
        } else if (confirmModal) {
          setConfirmModal(null);
        } else if (comparisonWords) {
          setComparisonWords(null);
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
  }, [detailContext, confirmModal, showKeyboardHelp, comparisonWords]);

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
      // 1. Pull latest items from server
      const remoteItems = await loadAllItems();

      // 2. Merge with latest state, strip images, then set state
      let mergedItems = normalizeSharedSRS(cleanupOldDeletedItems(
        mergeDatasets(latestItemsRef.current, remoteItems)
      ));
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
      if (changedItems.length > 0) {
        log(`Server: Force sync uploading ${changedItems.length} changed items`);
        const rehydrated = await rehydrateImagesForSync(changedItems);
        await saveItems(rehydrated);
        for (const item of changedItems) {
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
  }, []);

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
                  if (changedItems.length > 0) {
                    log(`Server: Pushing ${changedItems.length} changed items on background...`);
                    saveItems(changedItems).then(() => {
                      for (const item of changedItems) {
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
            const cachedItems = syncState.items;
            let processedItems: StoredItem[];
            let needsSaveToIDB = false;

            if (itemsFromIDB.length > 0) {
                // Use IndexedDB data (full content)
                // Check for items in cache that aren't in IDB (added but not yet saved to IDB)
                const idbIds = new Set(itemsFromIDB.map(i => i.data.id));
                const cacheOnlyItems = cachedItems.filter(i => !idbIds.has(i.data.id));
                if (cacheOnlyItems.length > 0) {
                    log(`📦 Found ${cacheOnlyItems.length} items in cache not in IndexedDB, adding them`);
                    processedItems = [...itemsFromIDB, ...cacheOnlyItems];
                    needsSaveToIDB = true;
                } else {
                    processedItems = itemsFromIDB;
                }
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

            // 3. Normalize shared SRS (ensure same-spelling siblings share one score)
            processedItems = normalizeSharedSRS(processedItems);

            // 3.5. Strip images from items → IDB (keep ~143MB out of React state)
            processedItems = await stripAndStoreImages(processedItems);

            // 4. Initialize sync state with merged data
            setSyncState({
                items: processedItems
            });

            // Also update the ref
            latestItemsRef.current = processedItems;
            
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

  // 2. SERVER SYNC — pull from server on mount, merge with local
  useEffect(() => {
    const syncFromServer = async () => {
      try {
        const remoteItems = await loadAllItems();
        if (remoteItems.length === 0) return;

        let mergedItems = mergeDatasets(latestItemsRef.current, remoteItems);
        mergedItems = cleanupOldDeletedItems(mergedItems);
        mergedItems = normalizeSharedSRS(mergedItems);

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
        if (catchUpItems.length > 0) {
          log(`Server: ${catchUpItems.length} items differ, uploading...`);
          rehydrateImagesForSync(catchUpItems).then(rehydrated => saveItems(rehydrated)).then(() => {
            for (const item of catchUpItems) {
              item.lastSyncedHash = getItemContentHash(item);
            }
          }).catch(e => logError("Catch-up sync failed:", e));
        }

        setSyncState({ items: mergedItems });
      } catch (error) {
        logError("Initial server sync failed:", error);
      }
    };

    // Only sync after local data is loaded
    if (isLoaded) {
      syncFromServer();
    }
  }, [isLoaded]);

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
        data: { id: item.data.id, ...(item.type === 'phrase' ? { query: (item.data as any).query } : { word: (item.data as any).word, sense: (item.data as any).sense }) },
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
        // Rehydrate images from IDB before pushing to server
        const itemsToSync = await rehydrateImagesForSync(itemsWithHashes.map(i => i.item));
        await saveItems(itemsToSync);

        for (const { item, hash } of itemsWithHashes) {
          item.lastSyncedHash = hash;
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

  const handleSave = (item: StoredItem) => {
    try {
      if (!item || !item.data || !item.data.id) return;

      const rawTitle = getItemTitle(item);
      const incomingTitle = String(rawTitle || '').toLowerCase().trim();
      if (!incomingTitle) return;

      // Offload any base64 images to IDB before putting into state
      const imagesToSave: Array<{ id: string; base64: string }> = [];
      let data = item.data;
      if (isVocabItem(item) && (data as VocabCard).imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: data.id, base64: (data as VocabCard).imageUrl! });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
      }
      if (isPhraseItem(item)) {
        const sr = data as SearchResult;
        if (sr.imageUrl?.startsWith('data:image/')) {
          imagesToSave.push({ id: sr.id, base64: sr.imageUrl });
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
      if (imagesToSave.length > 0) saveImagesBatch(imagesToSave);

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
          
          return {
            ...prevState,
            items: newItems
          };
        } else {
          // New item
          
          // SHARED SRS LOGIC: Check if there are any OTHER items with the same word
          // If so, inherit their SRS state
          let srsToUse = itemToSave.srs;
          
          const siblingItem = prevState.items.find(i => 
             !i.isDeleted && 
             String(getItemTitle(i) || '').toLowerCase().trim() === incomingTitle
          );
          
          if (siblingItem) {
              // Inherit SRS from sibling, but ensure ID matches the NEW item
              srsToUse = { ...siblingItem.srs, id: itemToSave.data.id };
          }

          const normalizedSRS = SRSAlgorithm.ensure(srsToUse, itemToSave.data.id, itemToSave.type);
          const finalItem = { 
            ...itemToSave, 
            srs: normalizedSRS,
            savedAt: now,
            updatedAt: now
          };
          
          return {
            ...prevState,
            items: [finalItem, ...prevState.items]
          };
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

    // Offload any incoming images to IDB before updating state
    const incomingImageUrl = getItemImageUrl(item);
    if (incomingImageUrl?.startsWith('data:image/')) {
      saveImage(item.data.id, incomingImageUrl);
    }
    if (isPhraseItem(item) && item.data.vocabs) {
      for (const v of item.data.vocabs) {
        if (v.imageUrl?.startsWith('data:image/')) {
          saveImage(v.id, v.imageUrl);
        }
      }
    }

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

  /**
   * Lazy load image from server if not in IDB yet.
   * Saves to IDB images store (not React state) to keep heap small.
   */
  const handleLazyLoadImage = useCallback(async (itemId: string) => {
    try {
      const remoteItem = await loadSingleItem(itemId);
      if (!remoteItem) return;

      const imagesToSave: Array<{ id: string; base64: string }> = [];

      const remoteImageUrl = getItemImageUrl(remoteItem);
      if (remoteImageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: remoteItem.data.id, base64: remoteImageUrl });
      }

      // Also grab vocab images for phrase items
      if (isPhraseItem(remoteItem) && remoteItem.data.vocabs) {
        for (const vocab of remoteItem.data.vocabs) {
          if (vocab.imageUrl?.startsWith('data:image/')) {
            imagesToSave.push({ id: vocab.id, base64: vocab.imageUrl });
          }
        }
      }

      if (imagesToSave.length > 0) {
        log(`🖼️ Lazy-loaded ${imagesToSave.length} images from server for: ${getItemTitle(remoteItem)}`);
        await saveImagesBatch(imagesToSave);
      }
    } catch (e) {
      warn("Failed to lazy-load image from server:", e);
    }
  }, []);

  const handleDelete = async (id: string) => {
    log('🗑️ App: Deleting item', id);
    
    const now = Date.now();
    
    // Use functional update to avoid stale closure issues
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

    // Update carousel immediately (before Firebase sync) so card disappears instantly
    removeItemFromDetailContext(id);

    // Immediately sync deletion to server (don't wait for 5s debounce)
    try {
      const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
      if (itemToSync) {
        const itemWithDelete = { ...itemToSync, isDeleted: true, updatedAt: now };
        log('🗑️ App: Immediately syncing deletion to server');
        await saveItems([itemWithDelete]);
        itemWithDelete.lastSyncedHash = getItemContentHash(itemWithDelete);
      }
    } catch (e) {
      logError('🗑️ App: Failed to sync deletion to server:', e);
    }
  };

  const handleArchive = async (id: string) => {
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

    // Update carousel immediately (before Firebase sync) so card disappears instantly
    removeItemFromDetailContext(id);

    // Immediately sync archive to server
    try {
      const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
      if (itemToSync) {
        const itemWithArchive = { ...itemToSync, isArchived: true, updatedAt: now };
        await saveItems([itemWithArchive]);
        itemWithArchive.lastSyncedHash = getItemContentHash(itemWithArchive);
      }
    } catch (e) {
      logError('📦 App: Failed to sync archive to server:', e);
    }
  };

  const handleUnarchive = async (id: string) => {
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
    try {
      const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
      if (itemToSync) {
        const itemWithUnarchive = { ...itemToSync, isArchived: false, updatedAt: now };
        await saveItems([itemWithUnarchive]);
        itemWithUnarchive.lastSyncedHash = getItemContentHash(itemWithUnarchive);
      }
    } catch (e) {
      logError('📦 App: Failed to sync unarchive to server:', e);
    }
  };

  // Word comparison handler
  const handleCompare = useCallback((words: string[]) => {
    if (words.length >= 2 && words.length <= 3) {
      setComparisonWords(words);
    }
  }, []);

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

  // Search handler - now triggers search in notebook
  const handleRecursiveSearch = (text: string) => {
      setCurrentView('notebook');
      setDetailContext(null);
      // The notebook will handle the search via its own search bar
      // We dispatch a custom event to set the search query
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('notebook-search', { detail: { query: text, forceAI: false, autoAIIfNoMatch: true } }));
      }, 100);
  };

  // Force refresh search - bypasses local cache and calls AI
  const handleForceRefreshSearch = (text: string) => {
      setCurrentView('notebook');
      setDetailContext(null);
      // Dispatch event to trigger AI search in notebook
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('notebook-search', { detail: { query: text, forceAI: true } }));
      }, 100);
  };

  // Updated handler to support groups
  const handleViewStoredItem = (groups: ItemGroup[], groupIndex: number, itemIndex: number) => {
      setDetailContext({ groups, groupIndex, itemIndex });
  };

  // SRS update — handles shared SRS atomically (all items with same title updated together)
  // Uses refs to communicate between the setSyncState updater and the post-update save logic,
  // avoiding reliance on closure-mutated variables (which is fragile across React versions).
  const srsUpdateResultRef = useRef<{ itemsToSync: StoredItem[]; allItems: StoredItem[] }>({ itemsToSync: [], allItems: [] });

  const updateSRS = async (itemId: string) => {
    const now = Date.now();

    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const targetItem = prevState.items.find(i => i.data.id === itemId);
      if (!targetItem) return prevState;

      // Find ALL items with the same word/query to update them together (Shared SRS)
      const targetTitle = getItemTitle(targetItem).toLowerCase().trim();

      const idsToUpdate = new Set<string>();
      idsToUpdate.add(itemId);

      prevState.items.forEach(item => {
          if (!item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle) {
              idsToUpdate.add(item.data.id);
          }
      });

      // Calculate NEW SRS state based on the MOST ADVANCED sibling's current state
      // This prevents regressing a card when a less-advanced sibling is reviewed
      const siblings = prevState.items.filter(item => idsToUpdate.has(item.data.id));
      const bestSibling = siblings.reduce((best, s) => {
        const bSrs = SRSAlgorithm.ensure(best.srs, best.data.id, best.type);
        const sSrs = SRSAlgorithm.ensure(s.srs, s.data.id, s.type);
        return sSrs.totalReviews > bSrs.totalReviews ? s : best;
      });
      const baseSRS = SRSAlgorithm.ensure(bestSibling.srs, bestSibling.data.id, bestSibling.type);
      const updatedSRS = SRSAlgorithm.updateAfterRemember(baseSRS);

      log(`🧠 SRS Update: ${targetTitle} - step ${baseSRS.totalReviews}→${updatedSRS.totalReviews}, stability=${updatedSRS.stability}d, next review in ${Math.round(updatedSRS.interval / 1440)}d`);

      // Update ALL matching items with the NEW SRS state
      const syncItems: StoredItem[] = [];
      const newItems = prevState.items.map(item => {
          if (idsToUpdate.has(item.data.id)) {
              const itemSpecificSRS = { ...updatedSRS, id: item.data.id };
              const updatedItem = { ...item, srs: itemSpecificSRS, updatedAt: now };
              syncItems.push(updatedItem);
              return updatedItem;
          }
          return item;
      });

      // Store results in ref (safe across React versions, unlike closure mutation)
      srsUpdateResultRef.current = { itemsToSync: syncItems, allItems: newItems };

      // Update ref immediately so event handlers have fresh data
      latestItemsRef.current = newItems;

      return { ...prevState, items: newItems };
    });

    // Read results from ref (guaranteed to be set by the updater above)
    const { itemsToSync, allItems: allUpdatedItems } = srsUpdateResultRef.current;
    
    // CRITICAL: Save to IndexedDB IMMEDIATELY after SRS update
    // This ensures learning progress is never lost even if user switches apps quickly
    // This is the primary persistence layer - Firebase sync is secondary
    if (allUpdatedItems.length > 0) {
      // Throttle localStorage cache writes during rapid review sessions (3-second window)
      // Uses latestItemsRef.current when flushing to get the most up-to-date items
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
        await userSaveData(allUpdatedItems);
        log(`💾 Immediately saved SRS update to IndexedDB`);
        // Record save time so event handlers can skip redundant saves
        lastSaveTimeRef.current = Date.now();
      } catch (e) {
        logError('💾 Failed to save SRS update to IndexedDB:', e);
      }
    }
    
    // Sync SRS updates to server immediately
    if (itemsToSync.length > 0) {
      try {
        log(`Server: Immediately syncing ${itemsToSync.length} SRS updates`);
        await saveItems(itemsToSync);
        for (const syncedItem of itemsToSync) {
          syncedItem.lastSyncedHash = getItemContentHash(syncedItem);
        }
      } catch (e) {
        logError('Server: Failed to sync SRS updates:', e);
      }
    }
  };

  // Handle scroll to hide/show nav bar
  const handleScroll = (e: React.UIEvent<HTMLElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;

    if (currentScrollY < 10) {
      setShowNav(true);
    } else if (currentScrollY > lastScrollYRef.current && currentScrollY > 100) {
      // Scrolling down
      setShowNav(false);
    } else if (currentScrollY < lastScrollYRef.current) {
      // Scrolling up
      setShowNav(true);
    }

    lastScrollYRef.current = currentScrollY;
  };

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

      {detailContext && (
        <ErrorBoundary
          onReset={() => setDetailContext(null)}
          fallbackMessage="Something went wrong displaying this card. Your data is safe — returning to notebook."
        >
          <DetailView
              groups={detailContext.groups}
              initialGroupIndex={detailContext.groupIndex}
              initialItemIndex={detailContext.itemIndex}
              onClose={() => setDetailContext(null)}
              onSave={handleSave}
              onDelete={handleDelete}
              onArchive={handleArchive}
              savedItems={activeItems}
              onSearch={handleRecursiveSearch}
              onRefresh={handleForceRefreshSearch}
              onLazyLoadImage={handleLazyLoadImage}
              onUpdateSRS={updateSRS}
              onCompare={handleCompare}
              onSaveSentence={handleSaveSentence}
              isSentenceSaved={isSentenceSaved}
          />
        </ErrorBoundary>
      )}

      {comparisonWords && (
          <ComparisonView
              words={comparisonWords}
              onClose={() => setComparisonWords(null)}
          />
      )}

      <main className="flex-1 relative w-full min-h-0 overflow-hidden">
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
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onSave={handleSave}
            onUpdateStoredItem={handleUpdateStoredItem}
            onCompare={handleCompare}
            onSaveSentence={handleSaveSentence}
            isSentenceSaved={isSentenceSaved}
            hasOverlay={!!detailContext || !!confirmModal || !!comparisonWords || showKeyboardHelp}
          />
        )}

        {currentView === 'study' && (
          <StudyEnhanced
            items={studyItems}
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
          />
        )}

      </main>

      <nav className={`fixed bottom-0 left-0 right-0 bg-white flex justify-between px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 z-30 transition-transform duration-300 ${showNav ? 'translate-y-0' : 'translate-y-full'}`}>
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
      {showKeyboardHelp && (
        <div 
          className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
          onClick={() => setShowKeyboardHelp(false)}
        >
          <div 
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in-95 duration-150 max-h-[80vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center">
                <Keyboard size={24} />
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-800">Keyboard Shortcuts</h3>
                <p className="text-sm text-slate-500">Navigate faster with your keyboard</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Navigation */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Navigation</h4>
                <div className="space-y-2">
                  <ShortcutRow keys={['1']} description="Go to Notebook" />
                  <ShortcutRow keys={['2']} description="Go to Sentences" />
                  <ShortcutRow keys={['3']} description="Go to Study" />
                  <ShortcutRow keys={['⌘', 'F']} description="Focus search input" />
                  <ShortcutRow keys={['?']} description="Show keyboard shortcuts" />
                  <ShortcutRow keys={['Esc']} description="Close modal / Go back / Clear search" />
                </div>
              </div>

              {/* Cards & Carousels */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Card View</h4>
                <div className="space-y-2">
                  <ShortcutRow keys={['←', '→']} description="Navigate between meanings" />
                  <ShortcutRow keys={['↑', '↓']} description="Navigate between words" />
                  <ShortcutRow keys={['S']} description="Toggle save" />
                  <ShortcutRow keys={['P']} description="Pronounce current word" />
                  <ShortcutRow keys={['R']} description="Mark as Remembered" />
                  <ShortcutRow keys={['Shift', 'R']} description="Reset memory strength" />
                  <ShortcutRow keys={['H']} description="Toggle header bar" />
                  <ShortcutRow keys={['D']} description="Delete current item" />
                  <ShortcutRow keys={['A']} description="Archive / Unarchive" />
                </div>
              </div>

              {/* Trackpad */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Trackpad Gestures</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-slate-600">Two-finger horizontal swipe</span>
                    <span className="text-xs text-slate-400">Navigate cards</span>
                  </div>
                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-slate-600">Two-finger vertical swipe</span>
                    <span className="text-xs text-slate-400">Navigate words</span>
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowKeyboardHelp(false)}
              className="mt-6 w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
};

export default App;
