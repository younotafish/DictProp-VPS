import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NotebookView } from './views/Notebook';
import { StudyEnhanced } from './views/StudyEnhanced';
import { SentencesView } from './views/SentencesView';
import { DetailView } from './views/DetailView';
import { ComparisonView } from './views/ComparisonView';
import { StoredItem, ViewState, SyncStatus, SyncState, SRSData, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, VocabCard, SearchResult, SentenceData, AppUser, ItemGroup, isPhraseItem, isVocabItem } from './types';
import { Book, BrainCircuit, Keyboard, MessageSquareQuote } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signOut, isConfigured, handleRedirectResult, loadUserData, loadSingleItem, getItemContentHash } from './services/firebase';
import { AuthDomainErrorModal } from './components/AuthDomainErrorModal';
import { ErrorModal } from './components/ErrorModal';
import { ConfirmModal } from './components/ConfirmModal';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { analyzeInput } from './services/aiService';
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
  
  // Simplified sync state (items only)
  // Try to instantly restore from localStorage cache for faster perceived load
  const [syncState, setSyncState] = useState<SyncState>(() => {
    try {
      const cached = localStorage.getItem('app_items_cache');
      if (cached) {
        const items = JSON.parse(cached);
        if (Array.isArray(items) && items.length > 0) {
          log(`⚡ Instant restore: ${items.length} items from cache`);
          return { items };
        }
      }
    } catch (e) {
      warn("Failed to restore items from cache", e);
    }
    return { items: [] };
  });
  
  // Ref to track the latest items - avoids stale closure issues in event handlers
  // This is updated synchronously whenever syncState changes
  const latestItemsRef = useRef<StoredItem[]>(syncState.items);
  
  // Track when we last saved to avoid redundant saves from event handlers
  const lastSaveTimeRef = useRef<number>(0);

  // Track synced content hashes by item ID to avoid re-syncing unchanged items
  // Stored in a ref (not state) to prevent the save effect from re-triggering itself
  const syncedHashesRef = useRef<Map<string, string>>(new Map());
  
  // Track last successful sync timestamp to enable Delta Sync
  const [lastSyncTime, setLastSyncTime] = useState<number>(() => {
      const saved = localStorage.getItem('last_successful_sync');
      return saved ? parseInt(saved, 10) : 0;
  });
  const lastSyncTimeRef = useRef(lastSyncTime);
  
  // Keep latestItemsRef in sync with state (synchronously, so event handlers always have current data)
  useEffect(() => {
    latestItemsRef.current = syncState.items;
  }, [syncState.items]);

  // Keep lastSyncTimeRef in sync
  useEffect(() => {
    lastSyncTimeRef.current = lastSyncTime;
  }, [lastSyncTime]);
  
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

  // Auth States (Firebase)
  const [user, setUser] = useState<AppUser | null>(null);
  const [unauthorizedDomain, setUnauthorizedDomain] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<{code?: string, message: string} | null>(null);
  const [isFirebaseConfigured, setIsFirebaseConfigured] = useState(isConfigured());

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
  // Defined before the visibilitychange effect that references it
  const handleForceSync = useCallback(async () => {
    if (!user || !isFirebaseConfigured || !isOnline) return;

    setSyncStatus('syncing');

    try {
      const currentItems = latestItemsRef.current;

      // 1. Upload changed local items to Firebase (delta sync)
      const changedItems: StoredItem[] = [];
      currentItems.forEach(item => {
        const currentHash = getItemContentHash(item);
        const lastSyncedHash = syncedHashesRef.current.get(item.data.id);
        if (currentHash !== lastSyncedHash) {
          changedItems.push(item);
        }
      });
      if (changedItems.length > 0) {
        log(`🔥 Firebase: Force sync uploading ${changedItems.length} changed items (of ${currentItems.length} total)`);
        await saveUserData(user.uid, changedItems);
      } else {
        log("🔥 Firebase: Force sync - no local changes to upload");
      }

      const now = Date.now();
      setLastSyncTime(now);
      localStorage.setItem('last_successful_sync', now.toString());

      // 2. Pull latest items from Firebase
      const remoteItems = await loadUserData(user.uid);

      // 3. Merge (including deleted items to propagate deletions)
      let mergedItems = mergeDatasets(currentItems, remoteItems);

      // 4. Clean up old deleted items (hard delete after retention period)
      const cleanedItems = normalizeSharedSRS(cleanupOldDeletedItems(mergedItems));

      // 5. Update synced hashes
      for (const item of cleanedItems) {
        syncedHashesRef.current.set(item.data.id, getItemContentHash(item));
      }

      latestItemsRef.current = cleanedItems;
      setSyncState(prevState => ({ ...prevState, items: cleanedItems }));
      setSyncStatus('saved');

    } catch (e) {
      logError("Force Sync Failed:", e);
      setSyncStatus('error');
    }
  }, [user, isFirebaseConfigured, isOnline]);

  // Save data before page unload (refresh, close tab, navigate away)
  // This is a critical safety net to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Use ref to get latest items (avoids stale closure)
      const currentItems = latestItemsRef.current;
      
      if (isLoaded && currentItems.length > 0) {
        const targetUserId = user?.uid || 'guest';
        
        // Skip if we just saved (within last 500ms) to avoid redundant writes
        const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
        if (timeSinceLastSave < 500) {
          log("💾 Skipping beforeunload save (recently saved)");
          return;
        }
        
        // Use synchronous localStorage as a backup (IndexedDB is async and may not complete)
        try {
          localStorage.setItem('app_items_cache', JSON.stringify(createLightweightCache(currentItems)));
          log("💾 Saved items cache on beforeunload");
        } catch (e) {
          warn("Failed to save cache on beforeunload:", e);
        }
        // Also try IndexedDB (may not complete but worth trying)
        saveData(currentItems, targetUserId).catch(e => warn("Failed to save on beforeunload:", e));
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLoaded, user]); // Removed syncState.items - we use ref instead

  // iOS PWA: Sync data when returning from background (instead of forcing reload)
  // CRITICAL: Also save to IndexedDB when going to background to prevent data loss
  useEffect(() => {
      const handleVisibilityChange = async () => {
          if (document.visibilityState === 'visible') {
              // Reset stuck speechSynthesis after backgrounding
              window.speechSynthesis?.cancel();
              const lastHiddenStr = localStorage.getItem('app_last_hidden');
              if (lastHiddenStr) {
                  const lastHidden = parseInt(lastHiddenStr, 10);
                  const now = Date.now();
                  // If app was in background for more than 30 seconds, trigger background sync
                  // (instead of a jarring full page reload)
                  if (now - lastHidden > 30 * 1000 && user && isOnline && isFirebaseConfigured) {
                      log("🔄 App was backgrounded for >30s, syncing in background...");
                      // Trigger a force sync instead of reloading the page
                      // This keeps the UI responsive while updating data
                      handleForceSync();
                  }
              }
              localStorage.removeItem('app_last_hidden');
          } else {
              // CRITICAL: Save to IndexedDB immediately when app goes to background
              // This prevents data loss when user switches apps quickly
              localStorage.setItem('app_last_hidden', Date.now().toString());
              
              // Use ref to get latest items (avoids stale closure)
              const currentItems = latestItemsRef.current;
              
              // Skip if we just saved (within last 500ms) to avoid redundant writes
              // and to prevent overwriting fresher data from updateSRS
              const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
              if (timeSinceLastSave < 500) {
                  log("💾 Skipping visibility change save (recently saved)");
                  return;
              }
              
              if (isLoaded && currentItems.length > 0) {
                  const targetUserId = user?.uid || 'guest';
                  log("💾 App going to background, saving data immediately...");
                  // Sync localStorage cache first (guaranteed to complete before iOS kills us)
                  try {
                    localStorage.setItem('app_items_cache', JSON.stringify(createLightweightCache(currentItems)));
                  } catch (e) {
                    warn("Failed to save cache on visibility change:", e);
                  }
                  // Also try IndexedDB (may not complete but worth trying)
                  saveData(currentItems, targetUserId).catch(e => {
                      warn("Failed to save on visibility change:", e);
                  });
              }
          }
      };
      
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user, isOnline, isFirebaseConfigured, isLoaded, handleForceSync]); // Removed syncState.items - we use ref instead

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    const initStorage = async () => {
        try {
            const migrated = await migrateFromLocalStorage();
            let itemsFromIDB: StoredItem[] = [];
            
            if (migrated && migrated.length > 0) {
                itemsFromIDB = migrated;
            } else {
                // Initially load guest data (user is not logged in yet)
                const items = await loadData('guest');
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

            // 4. Initialize sync state with merged data
            setSyncState({
                items: processedItems
            });

            // Also update the ref
            latestItemsRef.current = processedItems;
            
            // 4. Save merged result back to IndexedDB if we merged or made changes
            // This ensures IndexedDB is up-to-date with any fresher data from cache
            if (hasChanges || needsSaveToIDB) {
                await saveData(processedItems);
            }
        } catch (e) {
            logError("Failed to initialize storage", e);
        } finally {
            setIsLoaded(true);
        }
    };
    initStorage();
  }, []);

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

  // 2. FIREBASE SYNC LOGIC (Operation-Based)
  useEffect(() => {
    if (!isFirebaseConfigured) return;

    // Handle OAuth redirect result (for iOS Safari)
    handleRedirectResult().catch((error) => {
      if (error?.code === 'auth/unauthorized-domain') {
        setUnauthorizedDomain(window.location.host || window.location.origin || "Unable to detect URL");
      } else if (error?.message === "REDIRECT_FAILED_SILENTLY") {
        setSignInError({ 
            code: 'auth/safari-privacy', 
            message: "Sign-in failed due to Safari privacy settings. Please disable 'Prevent Cross-Site Tracking' in Settings > Safari and try again." 
        });
      } else if (error) {
        logError("Redirect result error:", error);
      }
    });

    let unsubscribeOps: (() => void) | undefined;

    const unsubscribeAuth = subscribeToAuth(async (currentUser) => {

      // Clean up previous subscriptions if they exist
      if (unsubscribeOps) {
        unsubscribeOps();
        unsubscribeOps = undefined;
      }
      
      if (currentUser) {
        // 1. Load User's specific local data (offline cache for this user)
        // This is the primary data source - always available offline
        const userLocalItems = await loadData(currentUser.uid);

        // Set user and local items FIRST (instant, works offline)
        setUser(currentUser);

        // Only replace items if user IDB has data
        // If IDB is empty (corruption from crashes), keep cache items visible
        // while Firestore fetch restores the correct data
        if (userLocalItems.length > 0) {
          const normalizedUserItems = normalizeSharedSRS(userLocalItems);
          latestItemsRef.current = normalizedUserItems;

          setSyncState(prevState => ({
              ...prevState,
              items: normalizedUserItems
          }));
        }
        
        // 2. Load Remote Data ONLY if online (background sync)
        // Skip cloud fetch when offline to avoid delays
        if (navigator.onLine) {
          try {
            const remoteItems = await loadUserData(currentUser.uid);
            
            // 3. Merge User Local + User Remote (INCLUDING deleted items for proper sync)
            // We must include deleted items in merge to propagate deletions across devices
            let mergedItems = mergeDatasets(userLocalItems, remoteItems);
            
            // 4. Clean up old deleted items during initial sync
            mergedItems = cleanupOldDeletedItems(mergedItems);
            
            // Update last sync time based on ALL remote data to avoid re-syncing what we just got
            const maxRemoteTime = remoteItems.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
            setLastSyncTime(prev => {
                const newTime = Math.max(prev, maxRemoteTime);
                localStorage.setItem('last_successful_sync', newTime.toString());
                return newTime;
            });

            // Update ref immediately so event handlers have fresh data
            latestItemsRef.current = mergedItems;

            // Normalize shared SRS after merge
            mergedItems = normalizeSharedSRS(mergedItems);
            latestItemsRef.current = mergedItems;

            // Update state with merged data
            setSyncState(prevState => ({
              ...prevState,
              items: mergedItems
            }));

            // CATCH-UP PUSH: Compare merged items against Firestore and upload any
            // that differ. This repairs Firestore when local IDB has full content but
            // Firestore has stripped data (from a past cache-to-Firestore overwrite).
            const remoteHashMap = new Map<string, string>();
            remoteItems.forEach(item => {
              if (item.data?.id) remoteHashMap.set(item.data.id, getItemContentHash(item));
            });
            const catchUpItems: StoredItem[] = [];
            mergedItems.forEach(item => {
              const mergedHash = getItemContentHash(item);
              const remoteHash = remoteHashMap.get(item.data.id);
              syncedHashesRef.current.set(item.data.id, mergedHash);
              if (mergedHash !== remoteHash) {
                catchUpItems.push(item);
              }
            });
            if (catchUpItems.length > 0) {
              log(`🔥 Firebase: Catch-up sync: ${catchUpItems.length} items differ from cloud, uploading...`);
              try {
                await saveUserData(currentUser.uid, catchUpItems);
                log(`🔥 Firebase: Catch-up sync complete`);
              } catch (e) {
                logError("Catch-up sync failed:", e);
              }
            } else {
              log("🔥 Firebase: No catch-up needed, local and cloud match");
            }
            
          } catch (error) {
            logError("Initial sync failed:", error);
            // Local items already set above, no action needed
          }
        } else {
          log("📴 Offline: Using local data only");
        }
        
        // Subscribe to real-time updates
        unsubscribeOps = subscribeToUserData(currentUser.uid, (remoteItems) => {
          // Update last sync time to avoid echo (use ALL items including deleted)
          const maxRemoteTime = remoteItems.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
          setLastSyncTime(prev => {
              const newTime = Math.max(prev, maxRemoteTime);
              localStorage.setItem('last_successful_sync', newTime.toString());
              return newTime;
          });

          setSyncState(prevState => {
            // Merge with ALL items including deleted to propagate deletions
            const mergedItems = normalizeSharedSRS(mergeDatasets(prevState.items, remoteItems));

            // Update ref immediately so event handlers have fresh data
            latestItemsRef.current = mergedItems;

            return {
              ...prevState,
              items: mergedItems
            };
          });
        });

      } else {
          // LOGGED OUT
          setUser(null);

          // Load guest data — only replace state if guest IDB has items
          // (preserve cache items if IDB is empty due to corruption)
          const guestItems = await loadData('guest');
          if (guestItems.length > 0) {
            const normalizedGuest = normalizeSharedSRS(guestItems);
            setSyncState(prevState => ({
                ...prevState,
                items: normalizedGuest
            }));
          }
      }
    });

    return () => {
      if (unsubscribeOps) unsubscribeOps();
      unsubscribeAuth();
    };
  }, [isFirebaseConfigured]);

  // Cache items to localStorage for instant restoration on iOS PWA reload
  // Strip images to stay within 5MB localStorage limit
  // If full cache doesn't fit, progressively shrink: drop vocabs from phrases,
  // then truncate to most recently updated items
  useEffect(() => {
    if (!isLoaded || syncState.items.length === 0) return;

    const fullCache = createLightweightCache(syncState.items);

    // Try full cache first
    try {
      localStorage.setItem('app_items_cache', JSON.stringify(fullCache));
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
      localStorage.setItem('app_items_cache', JSON.stringify(slimCache));
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
        localStorage.setItem('app_items_cache', JSON.stringify(essentialCache.slice(0, mid)));
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    if (lo > 0) {
      try {
        localStorage.setItem('app_items_cache', JSON.stringify(essentialCache.slice(0, lo)));
      } catch {
        // Give up — keep whatever was in cache before
      }
    }
    warn(`localStorage cache truncated to ${lo}/${syncState.items.length} items`);
  }, [syncState.items, isLoaded]);

  // 3. SAVE EFFECTS (Persistence + Simple Item Sync)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(async () => {
      // Use ref to get latest items (avoids stale closure in setTimeout)
      const currentItems = latestItemsRef.current;

      // 1. Save to Local IDB FIRST (always, works offline)
      // Skip if a recent immediate save (SRS update) happened within 2 seconds
      const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
      if (timeSinceLastSave < 2000) {
        log("💾 Skipping debounced IDB save (recent immediate save)");
      } else {
        // Save to user-specific storage or guest storage
        const targetUserId = user?.uid || 'guest';
        await saveData(currentItems, targetUserId);
      }

      // 2. Push items to Cloud (Firebase) - Delta Sync with Hash Comparison
      // NOTE: Don't gate on isOnline — navigator.onLine is unreliable on iOS PWA standalone mode.
      // Always attempt sync; the try/catch handles actual network failures gracefully.
      if (user && isFirebaseConfigured) {
          // Filter items that actually need writing:
          // 1. Must have been updated since last sync (timestamp check)
          // 2. Content hash must differ from last synced hash (prevents redundant writes)
          const itemsWithHashes: { item: StoredItem; hash: string }[] = [];

          currentItems.forEach(item => {
              const updated = item.updatedAt || 0;
              if (updated <= lastSyncTimeRef.current) return; // Skip if not updated since last sync

              const currentHash = getItemContentHash(item);
              const lastSyncedHash = syncedHashesRef.current.get(item.data.id);
              if (currentHash === lastSyncedHash) return; // Skip if content unchanged

              itemsWithHashes.push({ item, hash: currentHash });
          });

          if (itemsWithHashes.length === 0) {
              setSyncStatus('saved');
              return;
          }

          setSyncStatus('syncing');
          log(`🔥 Firebase: ${itemsWithHashes.length} items actually changed (hash check)`);

          try {
            await saveUserData(user.uid, itemsWithHashes.map(i => i.item));

            // Update last sync time
            const now = Date.now();
            setLastSyncTime(now);
            localStorage.setItem('last_successful_sync', now.toString());

            // Update synced hashes in ref (not state) to prevent re-triggering this effect
            for (const { item, hash } of itemsWithHashes) {
              syncedHashesRef.current.set(item.data.id, hash);
            }

            setSyncStatus('saved');
          } catch (e) {
            logError("Sync error:", e);
            setSyncStatus('error');
          }
      }

    }, 5000); // 5s debounce (user preference)

    return () => clearTimeout(timer);
  }, [syncState, isLoaded, user, isFirebaseConfigured]);

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

  const handleSignIn = async () => {
      try {
          await signIn();
      } catch (e: any) {
          const msg = e.message || '';
          const code = e.code || '';
          if (code === 'auth/unauthorized-domain' || msg.includes('unauthorized domain')) {
              setUnauthorizedDomain(window.location.host || window.location.origin || "Unable to detect URL");
              return;
          }
          if (code !== 'auth/popup-closed-by-user') {
             setSignInError({ code, message: msg });
          }
      }
  };

  const handleSignOut = async () => {
      await signOut();
      setUser(null);
      // Clear cached items to prevent stale data on next load
      localStorage.removeItem('app_items_cache');
  };


  const handleSave = (item: StoredItem) => {
    try {
      if (!item || !item.data || !item.data.id) return;
      
      const rawTitle = getItemTitle(item);
      const incomingTitle = String(rawTitle || '').toLowerCase().trim();
      if (!incomingTitle) return;
      
      const now = Date.now();
      const itemToSave = { 
        ...item, 
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
    
    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const itemId = item.data.id;
      
      // Case 1: Direct match by ID (top-level items)
      const index = prevState.items.findIndex(i => i.data.id === itemId);
      if (index >= 0) {
        const existingItem = prevState.items[index];
        const newItems = [...prevState.items];
        
        // Merge: keep existing fields, update with new data, preserve important metadata
        newItems[index] = {
          ...existingItem,
          data: {
            ...existingItem.data,
            ...item.data,
            // Preserve existing imageUrl if incoming doesn't have one
            imageUrl: getItemImageUrl(item) || getItemImageUrl(existingItem)
          },
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
              newVocabs[vocabIndex] = {
                ...newVocabs[vocabIndex],
                ...vocabData,
                // Preserve existing imageUrl if incoming doesn't have one
                imageUrl: vocabData.imageUrl || newVocabs[vocabIndex].imageUrl
              };
              
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
   * Lazy load image from Firebase if local item is missing it
   * Called when viewing a saved card that has no local image
   */
  const handleLazyLoadImage = useCallback(async (itemId: string) => {
    if (!user || !isOnline) return;
    
    try {
      const remoteItem = await loadSingleItem(user.uid, itemId);
      if (!remoteItem) return;
      
      const remoteImageUrl = getItemImageUrl(remoteItem);
      const hasRemoteImage = remoteImageUrl && remoteImageUrl.startsWith('data:image/');
      
      if (!hasRemoteImage) return;
      
      // Update local storage with the remote image
      setSyncState(prevState => {
        const index = prevState.items.findIndex(i => i.data.id === itemId);
        if (index >= 0) {
          const localItem = prevState.items[index];
          const localImageUrl = getItemImageUrl(localItem);
          const hasLocalImage = localImageUrl && localImageUrl.startsWith('data:image/');
          
          if (!hasLocalImage) {
            log(`🖼️ Lazy-loaded image from Firebase for: ${getItemTitle(remoteItem)}`);
            const newItems = [...prevState.items];
            
            // Handle vocab images for phrase items
            let updatedData = { ...localItem.data, imageUrl: remoteImageUrl };
            if (isPhraseItem(remoteItem) && isPhraseItem(localItem)) {
              const remoteVocabs = remoteItem.data.vocabs;
              const localVocabs = localItem.data.vocabs || [];
              if (remoteVocabs) {
                updatedData = {
                  ...updatedData,
                  vocabs: localVocabs.map((localVocab: VocabCard, i: number) => {
                    const remoteVocab = remoteVocabs[i];
                    if (remoteVocab?.imageUrl && !localVocab.imageUrl) {
                      return { ...localVocab, imageUrl: remoteVocab.imageUrl };
                    }
                    return localVocab;
                  })
                };
              }
            }
            
            newItems[index] = {
              ...prevState.items[index],
              data: updatedData,
              updatedAt: Date.now()
            };
            return { ...prevState, items: newItems };
          }
        }
        return prevState;
      });
    } catch (e) {
      warn("Failed to lazy-load image from Firebase:", e);
    }
  }, [user, isOnline]);

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

    // Immediately sync deletion to Firebase (don't wait for 5s debounce)
    // This ensures deletions propagate even if user closes app quickly
    if (user && isFirebaseConfigured) {
      try {
        // Use ref to get latest items (avoids stale closure)
        const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
        if (itemToSync) {
          const itemWithDelete = { ...itemToSync, isDeleted: true, updatedAt: now };
          log('🗑️ App: Immediately syncing deletion to Firebase');
          await saveUserData(user.uid, [itemWithDelete]);
        }
      } catch (e) {
        logError('🗑️ App: Failed to sync deletion to Firebase:', e);
        // Deletion is still saved locally, will retry on next sync
      }
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

    // Immediately sync archive to Firebase (don't wait for 5s debounce)
    if (user && isFirebaseConfigured) {
      try {
        // Use ref to get latest items (avoids stale closure)
        const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
        if (itemToSync) {
          const itemWithArchive = { ...itemToSync, isArchived: true, updatedAt: now };
          log('📦 App: Immediately syncing archive to Firebase');
          await saveUserData(user.uid, [itemWithArchive]);
        }
      } catch (e) {
        logError('📦 App: Failed to sync archive to Firebase:', e);
      }
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
    
    // Immediately sync unarchive to Firebase
    if (user && isFirebaseConfigured) {
      try {
        // Use ref to get latest items (avoids stale closure)
        const itemToSync = latestItemsRef.current.find(i => i.data.id === id);
        if (itemToSync) {
          const itemWithUnarchive = { ...itemToSync, isArchived: false, updatedAt: now };
          log('📦 App: Immediately syncing unarchive to Firebase');
          await saveUserData(user.uid, [itemWithUnarchive]);
        }
      } catch (e) {
        logError('📦 App: Failed to sync unarchive to Firebase:', e);
      }
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
    const targetUserId = user?.uid || 'guest';
    if (allUpdatedItems.length > 0) {
      // Also update localStorage cache synchronously (backup for iOS PWA)
      try {
        localStorage.setItem('app_items_cache', JSON.stringify(createLightweightCache(allUpdatedItems)));
      } catch (e) {
        warn("Failed to update cache after SRS:", e);
      }
      
      try {
        await saveData(allUpdatedItems, targetUserId);
        log(`💾 Immediately saved SRS update to IndexedDB`);
        // Record save time so event handlers can skip redundant saves
        lastSaveTimeRef.current = Date.now();
      } catch (e) {
        logError('💾 Failed to save SRS update to IndexedDB:', e);
      }
    }
    
    // Also sync SRS updates to Firebase (don't wait for 5s debounce)
    // This ensures learning progress syncs across devices
    // NOTE: Don't gate on isOnline — navigator.onLine is unreliable on iOS PWA standalone mode.
    // Instead, always attempt the save and let the try/catch handle network failures gracefully.
    if (user && isFirebaseConfigured && itemsToSync.length > 0) {
      try {
        log(`🔥 Firebase: Immediately syncing ${itemsToSync.length} SRS updates`);
        await saveUserData(user.uid, itemsToSync);
        // Update synced hashes so the debounced save doesn't re-upload these items
        for (const syncedItem of itemsToSync) {
          syncedHashesRef.current.set(syncedItem.data.id, getItemContentHash(syncedItem));
        }
      } catch (e) {
        logError('🔥 Firebase: Failed to sync SRS updates:', e);
        // Local state is already saved, will retry on next regular sync
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
      
      {unauthorizedDomain && <AuthDomainErrorModal domain={unauthorizedDomain} onClose={() => setUnauthorizedDomain(null)} />}
      {signInError && <ErrorModal error={signInError} onClose={() => setSignInError(null)} />}
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
            user={user}
            onSignIn={handleSignIn}
            onSignOut={handleSignOut}
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
