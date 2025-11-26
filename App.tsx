import React, { useState, useEffect } from 'react';
import { SearchView } from './views/Search';
import { NotebookView } from './views/Notebook';
import { StudyEnhanced } from './views/StudyEnhanced';
import { DetailView } from './views/DetailView';
import { StoredItem, ViewState, SRSData, SyncStatus, TaskType, SyncState, getItemTitle } from './types';
import { Search, Book, BrainCircuit } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signInAnonymouslyUser, signOut, isConfigured, handleRedirectResult, loadUserData } from './services/firebase';
import { AuthDomainErrorModal } from './components/AuthDomainErrorModal';
import { ErrorModal } from './components/ErrorModal';
import { SRSAlgorithm } from './services/srsAlgorithm';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewState>(() => {
    return (localStorage.getItem('app_current_view') as ViewState) || 'search';
  });

  // Persist current view
  useEffect(() => {
    localStorage.setItem('app_current_view', currentView);
  }, [currentView]);
  
  // Simplified sync state (items only)
  const [syncState, setSyncState] = useState<SyncState>({
    items: []
  });
  
  // Track last successful sync timestamp to enable Delta Sync
  const [lastSyncTime, setLastSyncTime] = useState<number>(() => {
      const saved = localStorage.getItem('last_successful_sync');
      return saved ? parseInt(saved, 10) : 0;
  });
  
  // Derived state
  const savedItems = syncState.items;
  
  const [recursiveQuery, setRecursiveQuery] = useState<string | undefined>(() => {
      return localStorage.getItem('app_last_query') || undefined;
  });
  
  useEffect(() => {
      if (recursiveQuery) {
          localStorage.setItem('app_last_query', recursiveQuery);
      } else {
          localStorage.removeItem('app_last_query');
      }
  }, [recursiveQuery]);

  const [selectedStoredItem, setSelectedStoredItem] = useState<StoredItem | undefined>(undefined);
  const [isLoaded, setIsLoaded] = useState(false);
  const [showNav, setShowNav] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');

  // Auth States (Firebase)
  const [user, setUser] = useState<any | null>(null);
  const [unauthorizedDomain, setUnauthorizedDomain] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<{code?: string, message: string} | null>(null);
  const [isFirebaseConfigured, setIsFirebaseConfigured] = useState(isConfigured());

  const [detailContext, setDetailContext] = useState<{ items: StoredItem[], index: number } | null>(null);


  // Force refresh logic for iOS PWA
  useEffect(() => {
      const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
              const lastHiddenStr = localStorage.getItem('app_last_hidden');
              if (lastHiddenStr) {
                  const lastHidden = parseInt(lastHiddenStr, 10);
                  const now = Date.now();
                  // If app was in background for more than 5 minutes, reload to refresh state
                  if (now - lastHidden > 5 * 60 * 1000) {
                      console.log("🔄 App was backgrounded for >5m, refreshing...");
                      window.location.reload();
                  }
              }
              localStorage.removeItem('app_last_hidden');
          } else {
              localStorage.setItem('app_last_hidden', Date.now().toString());
          }
      };
      
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);


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
                    srs: migrateSRSData(item.srs)
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
            
            // 4. Save if we made changes
            if (hasChanges) {
                await saveData(processedItems);
            }
        } catch (e) {
            console.error("Failed to initialize storage", e);
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
        console.error("Redirect result error:", error);
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
        const userLocalItems = await loadData(currentUser.uid);
        
        // 2. Load Remote Data
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

          // Set state and user together to avoid inconsistent renders
          setUser(currentUser);
          setSyncState(prevState => ({
            ...prevState,
            items: mergedItems
          }));
          
        } catch (error) {
          console.error("Initial sync failed:", error);
          // Still set the user and local items if remote fails
          setUser(currentUser);
          setSyncState(prevState => ({
              ...prevState,
              items: userLocalItems
          }));
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

  // 3. SAVE EFFECTS (Persistence + Simple Item Sync)
  useEffect(() => {
    if (!isLoaded) return; 

    const timer = setTimeout(async () => {
      // 1. Save to Local IDB
      // Save to user-specific storage or guest storage
      const targetUserId = user?.uid || 'guest';
      await saveData(syncState.items, targetUserId);
      
      // 2. Push items to Cloud (Firebase) - Delta Sync
      if (user && isFirebaseConfigured) {
          // Filter only changed items (updatedAt > lastSyncTime)
          const changedItems = syncState.items.filter(item => {
              const updated = item.updatedAt || 0;
              // Include if:
              // 1. Newer than last sync, OR
              // 2. Marked as deleted (deletions must always propagate)
              return updated > lastSyncTime || item.isDeleted;
          });

          if (changedItems.length === 0) {
              setSyncStatus('saved');
              return;
          }

          setSyncStatus('syncing');
          
          try {
            await saveUserData(user.uid, changedItems);
            
            // Update last sync time
            const now = Date.now();
            setLastSyncTime(now);
            localStorage.setItem('last_successful_sync', now.toString());

            setSyncStatus('saved');
          } catch (e) {
            console.error("Sync error:", e);
            setSyncStatus('error');
          }
      }

    }, 5000); // 5s debounce (user preference)

    return () => clearTimeout(timer);
  }, [syncState, isLoaded, user, isFirebaseConfigured, lastSyncTime]);

  const handleForceSync = async () => {
    if (!user || !isFirebaseConfigured) return;
    
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
      setSyncState(prevState => {
        const mergedItems = mergeDatasets(prevState.items, remoteItems);
        
        // 4. Clean up old deleted items (hard delete after retention period)
        const cleanedItems = cleanupOldDeletedItems(mergedItems);
        
        return {
          ...prevState,
          items: cleanedItems
        };
      });
      
      setSyncStatus('saved');
      
    } catch (e) {
      console.error("Force Sync Failed:", e);
      setSyncStatus('error');
    }
  };

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

  const handleGuestSignIn = async () => {
      try {
          await signInAnonymouslyUser();
      } catch (e: any) {
          setSignInError({ code: e.code, message: e.message });
      }
  };

  const handleSignOut = async () => {
      await signOut();
      setUser(null);
  };

  const migrateSRSData = (srs: SRSData): SRSData => {
    if (typeof srs.memoryStrength === 'number') return srs;
    
    const reviewCount = srs.history?.length || 0;
    const correctCount = srs.history?.filter(q => q >= 3).length || 0;
    const accuracy = reviewCount > 0 ? correctCount / reviewCount : 0;
    
    let initialStrength = 0;
    if (srs.easeFactor > 2.5) initialStrength += 30;
    if (srs.interval > 1440) initialStrength += 40;
    if (accuracy > 0.7) initialStrength += 30;
    
    return {
      ...srs,
      memoryStrength: Math.min(100, initialStrength),
      lastReviewDate: Date.now(),
      totalReviews: reviewCount,
      correctStreak: 0,
      taskHistory: [],
      stability: Math.max(0.5, srs.interval / (24 * 60)),
      difficulty: 5,
    };
  };

  const ensureSRSData = (
    srs: SRSData | undefined,
    fallbackId: string,
    fallbackType: 'vocab' | 'phrase'
  ): SRSData => {
    if (srs) {
      return migrateSRSData(srs);
    }
    return SRSAlgorithm.createNew(fallbackId, fallbackType);
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
            const incomingSense = item.type === 'vocab' ? ((item.data as any).sense || '') : '';
            
            existingIndex = prevState.items.findIndex(i => {
              const titleMatch = String(getItemTitle(i) || '').toLowerCase().trim() === incomingTitle;
              if (!titleMatch) return false;
              
              // For vocab items, also check if the sense matches
              // This allows saving multiple meanings of the same word
              if (item.type === 'vocab' && i.type === 'vocab') {
                const existingSense = (i.data as any).sense || '';
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
          const mergedSrs = ensureSRSData(
            existingItem.srs ?? itemToSave.srs,
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
          const normalizedSRS = ensureSRSData(itemToSave.srs, itemToSave.data.id, itemToSave.type);
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
      console.error("Error during save operation:", err);
    }
  };

  const handleUpdateStoredItem = (item: StoredItem) => {
    const rawTitle = getItemTitle(item);
    const incomingTitle = String(rawTitle || '').toLowerCase().trim();
    if (!incomingTitle) return;
    
    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const index = prevState.items.findIndex(i => i.data.id === item.data.id);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...item,
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

  const handleDelete = (id: string) => {
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
      return prevState;
    });
  };

  const handleRecursiveSearch = (text: string) => {
      setRecursiveQuery(text);
      setSelectedStoredItem(undefined);
      setCurrentView('search');
      setDetailContext(null); 
  };

  const handleViewStoredItem = (items: StoredItem[], index: number) => {
      setDetailContext({ items, index });
  };

  // Enhanced SRS update with new algorithm (using operations)
  const updateSRS = (itemId: string, quality: number, taskType: TaskType = 'recall', responseTime: number = 3000) => {
    // Use functional update to avoid stale closure issues
    setSyncState(prevState => {
      const item = prevState.items.find(i => i.data.id === itemId);
      if (!item) return prevState;
      
      // Migrate old SRS data if needed
      const migratedSRS = migrateSRSData(item.srs);
      
      // Use new algorithm
      const updatedSRS = SRSAlgorithm.updateAfterReview(
        migratedSRS,
        quality,
        taskType,
        responseTime
      );
      
      // Update SRS directly
      const index = prevState.items.findIndex(i => i.data.id === itemId);
      if (index >= 0) {
        const newItems = [...prevState.items];
        newItems[index] = {
          ...newItems[index],
          srs: updatedSRS,
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

  const NavButton = ({ view, icon: Icon, label }: { view: ViewState, icon: any, label: string }) => (
    <button 
      onClick={() => { setCurrentView(view); setRecursiveQuery(undefined); setSelectedStoredItem(undefined); }}
      className={`flex flex-col items-center justify-center flex-1 py-3 gap-1 transition-colors ${currentView === view ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
    >
      <Icon size={24} strokeWidth={currentView === view ? 2.5 : 2} />
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-white flex flex-col">
      {unauthorizedDomain && <AuthDomainErrorModal domain={unauthorizedDomain} onClose={() => setUnauthorizedDomain(null)} />}
      {signInError && <ErrorModal error={signInError} onClose={() => setSignInError(null)} />}

      {detailContext && (
          <DetailView 
              items={detailContext.items}
              initialIndex={detailContext.index}
              onClose={() => setDetailContext(null)}
              onSave={handleSave}
              onDelete={handleDelete}
              savedItems={savedItems.filter(i => !i.isDeleted)}
              onSearch={handleRecursiveSearch}
          />
      )}

      <main className="flex-1 relative w-full overflow-hidden">
        <div className={`h-full w-full ${currentView === 'search' ? 'block' : 'hidden'}`}>
             <SearchView 
                onSave={handleSave} 
                onUpdateStoredItem={handleUpdateStoredItem}
                onDelete={handleDelete} 
                savedItems={savedItems.filter(i => !i.isDeleted)} 
                initialQuery={recursiveQuery}
                initialData={selectedStoredItem}
                onViewDetail={(data, type) => {
                    const id = (data as any).id || 'temp';
                    setDetailContext({ 
                        items: [{ 
                            data, 
                            type, 
                            srs: SRSAlgorithm.createNew(id, type), 
                            savedAt: 0 
                        }], 
                        index: 0 
                    });
                }}
                onScroll={handleScroll}
                onClear={() => {
                    setRecursiveQuery(undefined);
                    setSelectedStoredItem(undefined);
                }}
            />
        </div>
        
        {currentView === 'notebook' && (
          <NotebookView 
            items={savedItems.filter(i => !i.isDeleted)} 
            onDelete={handleDelete} 
            onSearch={handleRecursiveSearch} 
            onViewDetail={handleViewStoredItem}
            user={user}
            onSignIn={handleSignIn}
            onGuestSignIn={handleGuestSignIn}
            onSignOut={handleSignOut}
            syncStatus={syncStatus}
            onScroll={handleScroll}
            onForceSync={handleForceSync}
          />
        )}
        
        {currentView === 'study' && (
          <StudyEnhanced
            items={savedItems.filter(i => !i.isDeleted)} 
            onUpdateSRS={updateSRS}
            onSearch={handleRecursiveSearch} 
            onDelete={handleDelete}
            onScroll={handleScroll}
            userId={user?.uid}
          />
        )}
      </main>

      <nav className={`fixed bottom-0 left-0 right-0 bg-white flex justify-between px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 z-30 transition-transform duration-300 ${showNav ? 'translate-y-0' : 'translate-y-full'}`}>
        <NavButton view="search" icon={Search} label="Search" />
        <NavButton view="notebook" icon={Book} label="Notebook" />
        <NavButton view="study" icon={BrainCircuit} label="Study" />
      </nav>
    </div>
  );
};

export default App;
