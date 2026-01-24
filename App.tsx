import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NotebookView } from './views/Notebook';
import { StudyEnhanced } from './views/StudyEnhanced';
import { DetailView } from './views/DetailView';
import { StoredItem, ViewState, SyncStatus, TaskType, SyncState, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, VocabCard, SearchResult, AppUser, ItemGroup, isPhraseItem, isVocabItem } from './types';
import { Book, BrainCircuit, Keyboard } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signOut, isConfigured, handleRedirectResult, loadUserData, loadSingleItem, getItemContentHash } from './services/firebase';
import { AuthDomainErrorModal } from './components/AuthDomainErrorModal';
import { ErrorModal } from './components/ErrorModal';
import { ConfirmModal } from './components/ConfirmModal';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { analyzeInput } from './services/geminiService';
import { useGlobalNavigation } from './hooks';
import { log, warn, error as logError } from './services/logger';

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

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewState>(() => {
    const saved = localStorage.getItem('app_current_view');
    // Default to notebook, and handle legacy 'search' value from old localStorage
    if (!saved || saved === 'search' || (saved !== 'notebook' && saved !== 'study')) {
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
  
  // Track last successful sync timestamp to enable Delta Sync
  const [lastSyncTime, setLastSyncTime] = useState<number>(() => {
      const saved = localStorage.getItem('last_successful_sync');
      return saved ? parseInt(saved, 10) : 0;
  });
  
  // Derived state - memoized filtered items
  const savedItems = syncState.items;
  const activeItems = useMemo(() => savedItems.filter(i => !i.isDeleted), [savedItems]);
  // Items available for study (excludes archived)
  const studyItems = useMemo(() => savedItems.filter(i => !i.isDeleted && !i.isArchived), [savedItems]);
  
  // Start as "loaded" if we have cached items (instant UI) 
  // Full data will be loaded from IndexedDB in background
  const [isLoaded, setIsLoaded] = useState(() => {
    try {
      const cached = localStorage.getItem('app_items_cache');
      return cached ? JSON.parse(cached).length > 0 : false;
    } catch {
      return false;
    }
  });
  const [showNav, setShowNav] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');

  // Auth States (Firebase)
  const [user, setUser] = useState<AppUser | null>(null);
  const [unauthorizedDomain, setUnauthorizedDomain] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<{code?: string, message: string} | null>(null);
  const [isFirebaseConfigured, setIsFirebaseConfigured] = useState(isConfigured());

  // Updated DetailContext to support Group-based navigation (2D: Groups vs Items)
  const [detailContext, setDetailContext] = useState<{ groups: ItemGroup[], groupIndex: number, itemIndex: number } | null>(() => {
    try {
      const saved = localStorage.getItem(DETAIL_CONTEXT_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      warn("Failed to restore detail context", e);
      return null;
    }
  });

  // Persist detailContext
  useEffect(() => {
    try {
      if (detailContext) {
        localStorage.setItem(DETAIL_CONTEXT_KEY, JSON.stringify(detailContext));
      } else {
        localStorage.removeItem(DETAIL_CONTEXT_KEY);
      }
    } catch (e) {
      warn("Failed to save detail context (quota exceeded?)", e);
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
  
  // Global keyboard navigation for tab switching (1, 2 keys)
  useGlobalNavigation({
    onNavigateToNotebook: () => {
      setCurrentView('notebook');
    },
    onNavigateToStudy: () => {
      setCurrentView('study');
    },
    enabled: !detailContext && !confirmModal && !showKeyboardHelp, // Disable when modals are open
  });

  // Global Escape key to close modals or go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
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
          const input = document.querySelector('input[placeholder*="Search notebook"]') as HTMLInputElement;
          input?.focus();
          input?.select();
        }, 100);
      }
      
      // ? key to show keyboard shortcuts (when not in input)
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInput && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowKeyboardHelp(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [detailContext, confirmModal, showKeyboardHelp]);

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

  // iOS PWA: Sync data when returning from background (instead of forcing reload)
  useEffect(() => {
      const handleVisibilityChange = async () => {
          if (document.visibilityState === 'visible') {
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
              localStorage.setItem('app_last_hidden', Date.now().toString());
          }
      };
      
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user, isOnline, isFirebaseConfigured]);

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    const initStorage = async () => {
        try {
            const migrated = await migrateFromLocalStorage();
            let itemsToLoad: StoredItem[] = [];
            
            if (migrated && migrated.length > 0) {
                itemsToLoad = migrated;
            } else {
                // Initially load guest data (user is not logged in yet)
                const items = await loadData('guest');
                if (items && Array.isArray(items)) {
                    itemsToLoad = items.filter((i: any) => 
                        i && i.data && i.data.id && i.srs && i.type && !i.isDeleted
                    );
                }
            }
            
            // Auto-migrate SRS data to new format if needed
            let processedItems = [...itemsToLoad];
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

            // 3. Initialize sync state
            setSyncState({
                items: processedItems
            });
            
            // 5. Save if we made changes
            if (hasChanges) {
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
      
      // Clean up previous subscription if it exists
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
        setSyncState(prevState => ({
            ...prevState,
            items: userLocalItems
        }));
        
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

            // Update state with merged data
            setSyncState(prevState => ({
              ...prevState,
              items: mergedItems
            }));
            
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
            const mergedItems = mergeDatasets(prevState.items, remoteItems);
            
            return {
              ...prevState,
              items: mergedItems
            };
          });
        });
      } else {
          // LOGGED OUT
          setUser(null);
          
          // Load guest data
          const guestItems = await loadData('guest');
          setSyncState(prevState => ({
              ...prevState,
              items: guestItems
          }));
      }
    });

    return () => {
      if (unsubscribeOps) unsubscribeOps();
      unsubscribeAuth();
    };
  }, [isFirebaseConfigured]);

  // Cache items to localStorage for instant restoration on iOS PWA reload
  // Strip images to stay within 5MB localStorage limit
  useEffect(() => {
    if (!isLoaded || syncState.items.length === 0) return;
    
    try {
      // Create a lightweight cache by stripping large base64 images
      const cacheItems = syncState.items.map(item => ({
        ...item,
        data: {
          ...item.data,
          imageUrl: undefined, // Strip image
          vocabs: isPhraseItem(item) && item.data.vocabs 
            ? item.data.vocabs.map((v: VocabCard) => ({ ...v, imageUrl: undefined }))
            : undefined
        }
      }));
      
      localStorage.setItem('app_items_cache', JSON.stringify(cacheItems));
    } catch (e) {
      // If quota exceeded, try to save just item count for UI feedback
      warn("Failed to cache items to localStorage", e);
    }
  }, [syncState.items, isLoaded]);

  // 3. SAVE EFFECTS (Persistence + Simple Item Sync)
  useEffect(() => {
    if (!isLoaded) return; 

    const timer = setTimeout(async () => {
      // 1. Save to Local IDB FIRST (always, works offline)
      // Save to user-specific storage or guest storage
      const targetUserId = user?.uid || 'guest';
      await saveData(syncState.items, targetUserId);
      
      // 2. Push items to Cloud (Firebase) - Delta Sync with Hash Comparison
      // Skip cloud sync when offline - will sync when back online
      if (user && isFirebaseConfigured && isOnline) {
          // Filter items that actually need writing:
          // 1. Must have been updated since last sync (timestamp check)
          // 2. Content hash must differ from last synced hash (prevents redundant writes)
          const itemsWithHashes: { item: StoredItem; hash: string }[] = [];
          
          syncState.items.forEach(item => {
              const updated = item.updatedAt || 0;
              if (updated <= lastSyncTime) return; // Skip if not updated since last sync
              
              const currentHash = getItemContentHash(item);
              if (currentHash === item.lastSyncedHash) return; // Skip if content unchanged
              
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
            
            // Update items with their new hashes to prevent re-syncing
            setSyncState(prevState => {
              const updatedItems = prevState.items.map(item => {
                const synced = itemsWithHashes.find(i => i.item.data.id === item.data.id);
                if (synced) {
                  return { ...item, lastSyncedHash: synced.hash };
                }
                return item;
              });
              return { ...prevState, items: updatedItems };
            });

            setSyncStatus('saved');
          } catch (e) {
            logError("Sync error:", e);
            setSyncStatus('error');
          }
      } else if (!isOnline) {
          // Offline - data saved locally, will sync when online
          setSyncStatus('saved');
      }

    }, 5000); // 5s debounce (user preference)

    return () => clearTimeout(timer);
  }, [syncState, isLoaded, user, isFirebaseConfigured, lastSyncTime, isOnline]);

  const handleForceSync = async () => {
    if (!user || !isFirebaseConfigured || !isOnline) return;
    
    setSyncStatus('syncing');
    
    try {
      // 1. Upload local items to Firebase
      await saveUserData(user.uid, syncState.items);
      
      // Update last sync time after force sync
      const now = Date.now();
      setLastSyncTime(now);
      localStorage.setItem('last_successful_sync', now.toString());

      // 2. Pull latest items from Firebase
      const remoteItems = await loadUserData(user.uid);
      
      // 3. Merge (including deleted items to propagate deletions)
      const currentItems = syncState.items;
      let mergedItems = mergeDatasets(currentItems, remoteItems);
      
      // 4. Clean up old deleted items (hard delete after retention period)
      const cleanedItems = cleanupOldDeletedItems(mergedItems);
      
      // 5. Update hashes for all items to prevent re-syncing on next regular sync
      const itemsWithHashes = cleanedItems.map(item => ({
        ...item,
        lastSyncedHash: getItemContentHash(item)
      }));
      
      setSyncState(prevState => ({
        ...prevState,
        items: itemsWithHashes
      }));
      
      setSyncStatus('saved');
      
    } catch (e) {
      logError("Force Sync Failed:", e);
      setSyncStatus('error');
    }
  };

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
        // Re-search with the updated Gemini prompts
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

  const handleDelete = (id: string) => {
    log('🗑️ App: Deleting item', id);
    
    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isDeleted: true,
          updatedAt: Date.now()
        };
        
        return {
          ...prevState,
          items: newItems
        };
      }
      warn('🗑️ App: Item not found for deletion:', id);
      return prevState;
    });
    
    // Update detailContext to remove the deleted item (instead of closing entirely)
    setDetailContext(prev => {
      if (!prev) return null;
      
      // Create new groups with the deleted item removed
      const newGroups = prev.groups.map(group => ({
        ...group,
        items: group.items.filter(item => item.data.id !== id)
      })).filter(group => group.items.length > 0); // Remove empty groups
      
      // If no groups left, close the view
      if (newGroups.length === 0) {
        return null;
      }
      
      // Adjust indices if needed
      let newGroupIndex = prev.groupIndex;
      let newItemIndex = prev.itemIndex;
      
      // If current group was removed or index is out of bounds
      if (newGroupIndex >= newGroups.length) {
        newGroupIndex = newGroups.length - 1;
      }
      
      // If current item index is out of bounds for the new group
      if (newItemIndex >= newGroups[newGroupIndex].items.length) {
        newItemIndex = Math.max(0, newGroups[newGroupIndex].items.length - 1);
      }
      
      return {
        groups: newGroups,
        groupIndex: newGroupIndex,
        itemIndex: newItemIndex
      };
    });
  };

  const handleArchive = (id: string) => {
    log('📦 App: Archiving item', id);
    
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isArchived: true,
          updatedAt: Date.now()
        };
        
        return {
          ...prevState,
          items: newItems
        };
      }
      warn('📦 App: Item not found for archiving:', id);
      return prevState;
    });
    
    // Update detailContext to remove the archived item (instead of closing entirely)
    setDetailContext(prev => {
      if (!prev) return null;
      
      // Create new groups with the archived item removed
      const newGroups = prev.groups.map(group => ({
        ...group,
        items: group.items.filter(item => item.data.id !== id)
      })).filter(group => group.items.length > 0);
      
      if (newGroups.length === 0) {
        return null;
      }
      
      let newGroupIndex = prev.groupIndex;
      let newItemIndex = prev.itemIndex;
      
      if (newGroupIndex >= newGroups.length) {
        newGroupIndex = newGroups.length - 1;
      }
      
      if (newItemIndex >= newGroups[newGroupIndex].items.length) {
        newItemIndex = Math.max(0, newGroups[newGroupIndex].items.length - 1);
      }
      
      return {
        groups: newGroups,
        groupIndex: newGroupIndex,
        itemIndex: newItemIndex
      };
    });
  };

  const handleUnarchive = (id: string) => {
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          isArchived: false,
          updatedAt: Date.now()
        };
        
        return {
          ...prevState,
          items: newItems
        };
      }
      return prevState;
    });
  };

  // Search handler - now triggers search in notebook
  const handleRecursiveSearch = (text: string) => {
      setCurrentView('notebook');
      setDetailContext(null);
      // The notebook will handle the search via its own search bar
      // We dispatch a custom event to set the search query
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('notebook-search', { detail: { query: text, forceAI: false } }));
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

  // Enhanced SRS update with new algorithm (using operations)
  const updateSRS = (itemId: string, quality: number, taskType: TaskType = 'recall', responseTime: number = 3000) => {
    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const targetItem = prevState.items.find(i => i.data.id === itemId);
      if (!targetItem) return prevState;
      
      // Find ALL items with the same word/query to update them together (Shared SRS)
      // Case-insensitive matching
      const targetTitle = getItemTitle(targetItem).toLowerCase().trim();
      
      // Identify IDs to update (current + siblings)
      const idsToUpdate = new Set<string>();
      idsToUpdate.add(itemId);
      
      prevState.items.forEach(item => {
          if (!item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle) {
              idsToUpdate.add(item.data.id);
          }
      });
      
      // Calculate NEW SRS state based on the target item's current state
      // We use the target item as the "source of truth" for the previous state
      const migratedSRS = SRSAlgorithm.migrate(targetItem.srs);
      const updatedSRS = SRSAlgorithm.updateAfterReview(
        migratedSRS,
        quality,
        taskType,
        responseTime
      );
      
      // Update ALL matching items with the NEW SRS state
      const newItems = prevState.items.map(item => {
          if (idsToUpdate.has(item.data.id)) {
              // Create a copy of the updated SRS with the correct ID for this specific item
              const itemSpecificSRS = { ...updatedSRS, id: item.data.id };
              
              return {
                  ...item,
                  srs: itemSpecificSRS,
                  updatedAt: Date.now()
              };
          }
          return item;
      });
      
      return {
          ...prevState,
          items: newItems
      };
    });
  };

  // Handle scroll to hide/show nav bar
  const handleScroll = (e: React.UIEvent<HTMLElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;
    
    if (currentScrollY < 10) {
      setShowNav(true);
    } else if (currentScrollY > lastScrollY && currentScrollY > 100) {
      // Scrolling down
      setShowNav(false);
    } else if (currentScrollY < lastScrollY) {
      // Scrolling up
      setShowNav(true);
    }
    
    setLastScrollY(currentScrollY);
  };

  const NavButton = ({ view, icon: Icon, label }: { view: ViewState, icon: React.ComponentType<{ size?: number; strokeWidth?: number }>, label: string }) => (
    <button 
      onClick={() => setCurrentView(view)}
      className={`flex flex-col items-center justify-center flex-1 py-3 gap-1 transition-colors ${currentView === view ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
    >
      <Icon size={24} strokeWidth={currentView === view ? 2.5 : 2} />
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </button>
  );

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
          />
        )}
        
        {currentView === 'study' && (
          <StudyEnhanced
            items={studyItems} 
            onUpdateSRS={updateSRS}
            onSearch={handleRecursiveSearch} 
            onDelete={handleDelete}
            onArchive={handleArchive}
            onScroll={handleScroll}
            userId={user?.uid}
            onLazyLoadImage={handleLazyLoadImage}
          />
        )}
      </main>

      <nav className={`fixed bottom-0 left-0 right-0 bg-white flex justify-between px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 z-30 transition-transform duration-300 ${showNav ? 'translate-y-0' : 'translate-y-full'}`}>
        <NavButton view="notebook" icon={Book} label="Notebook" />
        <NavButton view="study" icon={BrainCircuit} label="Study" />
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
                  <ShortcutRow keys={['2']} description="Go to Study" />
                  <ShortcutRow keys={['⌘', 'F']} description="Focus search input" />
                  <ShortcutRow keys={['Esc']} description="Close modal / Go back" />
                </div>
              </div>

              {/* Cards & Carousels */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Cards & Carousels</h4>
                <div className="space-y-2">
                  <ShortcutRow keys={['←', '→']} description="Navigate between cards" />
                  <ShortcutRow keys={['↑', '↓']} description="Navigate between words" />
                  <ShortcutRow keys={['Space']} description="Flip flashcard" />
                  <ShortcutRow keys={['Enter']} description="Open selected card" />
                  <ShortcutRow keys={['P']} description="Pronounce current word" />
                  <ShortcutRow keys={['R']} description="Mark as Remembered" />
                  <ShortcutRow keys={['Shift', 'R']} description="Reset memory strength" />
                </div>
              </div>

              {/* Study Mode */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Study Mode</h4>
                <div className="space-y-2">
                  <ShortcutRow keys={['←']} description="Mark as Forgot" />
                  <ShortcutRow keys={['→']} description="Mark as Got it" />
                  <ShortcutRow keys={['Space']} description="Flip card to reveal answer" />
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
