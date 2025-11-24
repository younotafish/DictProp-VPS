
import React, { useState, useEffect, useRef } from 'react';
import { SearchView } from './views/Search';
import { NotebookView } from './views/Notebook';
import { StudyView } from './views/Study';
import { StudyEnhanced } from './views/StudyEnhanced';
import { DetailView } from './views/DetailView';
import { StoredItem, ViewState, VocabCard, SRSData, SearchResult, SyncStatus, TaskType, SyncState } from './types';
import { Search, Book, BrainCircuit } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signInAnonymouslyUser, signOut, isConfigured, handleRedirectResult, loadUserData } from './services/firebase';
import { FirebaseConfigModal } from './components/FirebaseConfigModal';
import { AuthDomainErrorModal } from './components/AuthDomainErrorModal';
import { ErrorModal } from './components/ErrorModal';
import { SRSAlgorithm } from './services/srsAlgorithm';

const getItemTitle = (item: StoredItem): string => {
    if (!item || !item.data) return '';
    const data = item.data as any;
    const val = (item.type === 'phrase' ? data.query : data.word);
    return String(val || '');
};

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewState>('search');
  
  // Simplified sync state (items only)
  const [syncState, setSyncState] = useState<SyncState>({
    items: [],
    operations: [],
    pendingOps: [],
    lastSyncedOpId: null,
    deviceId: ''
  });
  
  // Track last successful sync timestamp to enable Delta Sync
  const [lastSyncTime, setLastSyncTime] = useState<number>(() => {
      const saved = localStorage.getItem('last_successful_sync');
      return saved ? parseInt(saved, 10) : 0;
  });
  
  // Derived state
  const savedItems = syncState.items;
  
  const [recursiveQuery, setRecursiveQuery] = useState<string | undefined>(undefined);
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

  // Swipe Logic Refs
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const touchEndY = useRef<number | null>(null);
  const minSwipeDistance = 50;

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

  const onTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.overflow-x-auto')) {
        touchStartX.current = null;
        return;
    }
    touchEndX.current = null;
    touchEndY.current = null;
    touchStartX.current = e.targetTouches[0].clientX;
    touchStartY.current = e.targetTouches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
    touchEndY.current = e.targetTouches[0].clientY;
  };

  const onTouchEnd = () => {
    // DISABLED: Tab swipe navigation to prevent conflicts with card swipe gestures
    return;
  };

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    const initStorage = async () => {
        try {
            console.log("🔧 Initializing storage and sync system...");
            
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
                console.log("🔄 Migrating", processedItems.length, "items to new SRS format...");
                processedItems = processedItems.map(item => ({
                    ...item,
                    srs: migrateSRSData(item.srs)
                }));
                hasChanges = true;
                console.log("✅ SRS migration complete!");
            }

            // 2. Timestamp Fix (for Sync)
            const needsTimestampFix = processedItems.some(item => !item.updatedAt && !item.savedAt);
            if (needsTimestampFix) {
                console.log("🔄 Fixing missing timestamps for sync compatibility...");
                const now = Date.now();
                processedItems = processedItems.map(item => {
                    if (!item.updatedAt && !item.savedAt) {
                        return { ...item, savedAt: now, updatedAt: now };
                    }
                    return item;
                });
                hasChanges = true;
                console.log("✅ Timestamp fix complete!");
            }

            // 3. Initialize sync state (simple items only)
            setSyncState({
                items: processedItems,
                operations: [],
                pendingOps: [],
                lastSyncedOpId: null,
                deviceId: ''
            });
            
            // 5. Save if we made changes
            if (hasChanges) {
                await saveData(processedItems);
            }
            
            console.log("✅ Storage initialization complete");
        } catch (e) {
            console.error("Failed to initialize storage", e);
        } finally {
            setIsLoaded(true);
        }
    };
    initStorage();
  }, []);

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
        console.log("🔥 Setting up sync for user:", currentUser.uid);
        
        // 1. Load User's specific local data (offline cache for this user)
        console.log("📥 Loading local data for user...");
        const userLocalItems = await loadData(currentUser.uid);
        
        // 2. Load Remote Data
        try {
          console.log("🔥 📥 Fetching items from Firebase...");
          const remoteItems = await loadUserData(currentUser.uid);
          const activeRemoteItems = remoteItems.filter(item => !item.isDeleted);
          console.log(`🔥 📥 Loaded ${activeRemoteItems.length} items from Firebase`);
          
          // 3. Merge User Local + User Remote
          // (We purposely do NOT merge 'guest' items here to prevent data leaks between accounts)
          const mergedItems = mergeDatasets(userLocalItems, activeRemoteItems);
          console.log(`🔥 ✅ Initial sync complete: ${mergedItems.length} items`);
          
          // Update last sync time based on remote data to avoid re-syncing what we just got
          const maxRemoteTime = activeRemoteItems.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
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
          console.error("🔥 ❌ Initial sync failed:", error);
          // Still set the user and local items if remote fails
          setUser(currentUser);
          setSyncState(prevState => ({
              ...prevState,
              items: userLocalItems
          }));
        }
        
        // Subscribe to real-time updates
        unsubscribeOps = subscribeToUserData(currentUser.uid, (remoteItems) => {
          const activeRemoteItems = remoteItems.filter(item => !item.isDeleted);
          console.log(`🔥 📥 Received ${activeRemoteItems.length} items from subscription`);
          
          // Update last sync time to avoid echo
          const maxRemoteTime = activeRemoteItems.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
          setLastSyncTime(prev => {
              const newTime = Math.max(prev, maxRemoteTime);
              localStorage.setItem('last_successful_sync', newTime.toString());
              return newTime;
          });

          setSyncState(prevState => {
            const mergedItems = mergeDatasets(prevState.items, activeRemoteItems);
            console.log(`🔥 ✅ Merged: ${mergedItems.length} items total`);
            
            return {
              ...prevState,
              items: mergedItems
            };
          });
        });
      } else {
          // LOGGED OUT
          console.log("👋 User logged out, switching to guest storage");
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
      console.log("🔥 Cleaning up Firebase subscriptions");
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
      console.log(`💾 Saved to IndexedDB (${targetUserId}): ${syncState.items.length} items`);
      
      // 2. Push items to Cloud (Firebase) - Delta Sync
      if (user && isFirebaseConfigured) {
          // Filter only changed items (updatedAt > lastSyncTime)
          const changedItems = syncState.items.filter(item => {
              const updated = item.updatedAt || 0;
              // Include if newer than last sync
              return updated > lastSyncTime;
          });

          if (changedItems.length === 0) {
              setSyncStatus('saved');
              return;
          }

          setSyncStatus('syncing');
          
          try {
            console.log(`🔥 Syncing ${changedItems.length} changed items to Firebase...`);
            await saveUserData(user.uid, changedItems);
            
            // Update last sync time
            const now = Date.now();
            setLastSyncTime(now);
            localStorage.setItem('last_successful_sync', now.toString());

            console.log("🔥 ✅ Items synced to Firebase!");
            setSyncStatus('saved');
          } catch (e) {
            console.error("🔥 ❌ Sync error:", e);
            setSyncStatus('error');
          }
      }

    }, 5000); // 5s debounce (user preference)

    return () => clearTimeout(timer);
  }, [syncState, isLoaded, user, isFirebaseConfigured, lastSyncTime]);

  const handleForceSync = async () => {
    if (!user || !isFirebaseConfigured) return;
    
    console.log("🔥 Force Sync Initiated");
    setSyncStatus('syncing');
    
    try {
      // 1. Upload local items to Firebase
      console.log(`🔥 Force Sync: Uploading ${syncState.items.length} items...`);
      await saveUserData(user.uid, syncState.items);
      
      // Update last sync time after force sync
      const now = Date.now();
      setLastSyncTime(now);
      localStorage.setItem('last_successful_sync', now.toString());

      // 2. Pull latest items from Firebase
      console.log("🔥 Force Sync: Fetching latest items...");
      const remoteItems = await loadUserData(user.uid);
      const activeRemoteItems = remoteItems.filter(item => !item.isDeleted);
      console.log(`🔥 Force Sync: Loaded ${activeRemoteItems.length} items from server`);
      
      // 3. Merge
      setSyncState(prevState => {
        const mergedItems = mergeDatasets(prevState.items, activeRemoteItems);
        console.log(`🔥 Force Sync: Merged! ${mergedItems.length} items total`);
        return {
          ...prevState,
          items: mergedItems
        };
      });
      
      setSyncStatus('saved');
      console.log("🔥 Force Sync: Complete!");
      
    } catch (e) {
      console.error("🔥 Force Sync Failed:", e);
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
      
      const itemToSave = { 
        ...item, 
        updatedAt: Date.now(),
        savedAt: item.savedAt || Date.now(),
        isDeleted: false 
      };

      // Check if item already exists
      // PRIORITY: Check by ID first
      let existingIndex = syncState.items.findIndex(i => i.data.id === item.data.id);
      
      // If not found by ID, check by Title (fallback for legacy or duplicates prevention)
      if (existingIndex === -1 && incomingTitle) {
          existingIndex = syncState.items.findIndex(i => 
            String(getItemTitle(i) || '').toLowerCase().trim() === incomingTitle
          );
      }

      if (existingIndex >= 0) {
        // Update existing item
        const existingItem = syncState.items[existingIndex];
        
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
          savedAt: existingItem.savedAt || Date.now(),
          updatedAt: Date.now(),
          srs: mergedSrs
        };
        
        // Update items array directly
        const newItems = [...syncState.items];
        newItems[existingIndex] = mergedItem;
        
        setSyncState({
          ...syncState,
          items: newItems
        });
      } else {
        // New item
        const normalizedSRS = ensureSRSData(itemToSave.srs, itemToSave.data.id, itemToSave.type);
        const finalItem = { 
          ...itemToSave, 
          srs: normalizedSRS,
          savedAt: Date.now(),
          updatedAt: Date.now()
        };
        
        setSyncState({
          ...syncState,
          items: [finalItem, ...syncState.items]
        });
      }
    } catch (err) {
      console.error("Error during save operation:", err);
    }
  };

  const handleUpdateStoredItem = (item: StoredItem) => {
    const rawTitle = getItemTitle(item);
    const incomingTitle = String(rawTitle || '').toLowerCase().trim();
    if (!incomingTitle) return;
    
    // Update item directly
    const index = syncState.items.findIndex(i => i.data.id === item.data.id);
    if (index >= 0) {
      const newItems = [...syncState.items];
      newItems[index] = {
        ...item,
        updatedAt: Date.now()
      };
      
      setSyncState({
        ...syncState,
        items: newItems
      });
    }
  };

  const handleDelete = (id: string) => {
    // Mark item as deleted
    const index = syncState.items.findIndex(i => i.data.id === id);
    if (index >= 0) {
      const newItems = [...syncState.items];
      newItems[index] = {
        ...newItems[index],
        isDeleted: true,
        updatedAt: Date.now()
      };
      
      setSyncState({
        ...syncState,
        items: newItems
      });
    }
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
    const item = syncState.items.find(i => i.data.id === itemId);
    if (!item) return;
    
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
    const index = syncState.items.findIndex(i => i.data.id === itemId);
    if (index >= 0) {
      const newItems = [...syncState.items];
      newItems[index] = {
        ...newItems[index],
        srs: updatedSRS,
        updatedAt: Date.now()
      };
      
      setSyncState({
        ...syncState,
        items: newItems
      });
    }
  };

  // Legacy updateSRS for backward compatibility with old Study view
  const updateSRSLegacy = (itemId: string, quality: number) => {
    updateSRS(itemId, quality, 'recall', 3000);
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

      <main 
        className="flex-1 relative w-full overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className={`h-full w-full ${currentView === 'search' ? 'block' : 'hidden'}`}>
             <SearchView 
                onSave={handleSave} 
                onUpdateStoredItem={handleUpdateStoredItem}
                onDelete={handleDelete} 
                savedItems={savedItems.filter(i => !i.isDeleted)} 
                initialQuery={recursiveQuery}
                initialData={selectedStoredItem}
                onViewDetail={(data, type) => setDetailContext({ items: [{ data, type, srs: {} as any, savedAt: 0 }], index: 0 })}
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
            isConfigured={isFirebaseConfigured}
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
