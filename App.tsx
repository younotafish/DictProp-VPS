
import React, { useState, useEffect, useRef } from 'react';
import { SearchView } from './views/Search';
import { NotebookView } from './views/Notebook';
import { StudyView } from './views/Study';
import { StudyEnhanced } from './views/StudyEnhanced';
import { DetailView } from './views/DetailView';
import { StoredItem, ViewState, VocabCard, SRSData, SearchResult, SyncStatus, TaskType } from './types';
import { Search, Book, BrainCircuit } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signInAnonymouslyUser, signOut, isConfigured, handleRedirectResult } from './services/firebase';
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
  const [savedItems, setSavedItems] = useState<StoredItem[]>([]);
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

  const [detailItem, setDetailItem] = useState<{data: VocabCard | SearchResult, type: 'vocab' | 'phrase'} | null>(null);

  // Swipe Logic Refs
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const touchEndY = useRef<number | null>(null);
  const minSwipeDistance = 50;

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
    if (!touchStartX.current || !touchEndX.current || !touchStartY.current || !touchEndY.current) return;
    
    const dx = touchStartX.current - touchEndX.current;
    const dy = touchStartY.current - touchEndY.current;

    // Scroll detection
    if (Math.abs(dy) > Math.abs(dx)) return;

    const isLeftSwipe = dx > minSwipeDistance;
    const isRightSwipe = dx < -minSwipeDistance;
    
    if (isLeftSwipe) {
        if (currentView === 'search') setCurrentView('notebook');
        else if (currentView === 'notebook') setCurrentView('study');
    }
    if (isRightSwipe) {
        if (currentView === 'study') setCurrentView('notebook');
        else if (currentView === 'notebook') setCurrentView('search');
    }
  };

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    const initStorage = async () => {
        try {
            const migrated = await migrateFromLocalStorage();
            let itemsToLoad: StoredItem[] = [];
            
            if (migrated && migrated.length > 0) {
                itemsToLoad = migrated;
            } else {
                const items = await loadData();
                if (items && Array.isArray(items)) {
                    itemsToLoad = items.filter((i: any) => 
                        i && i.data && i.data.id && i.srs && i.type && !i.isDeleted
                    );
                }
            }
            
            // Auto-migrate SRS data to new format if needed
            const needsMigration = itemsToLoad.some(item => typeof item.srs?.memoryStrength !== 'number');
            if (needsMigration && itemsToLoad.length > 0) {
                console.log("🔄 Migrating", itemsToLoad.length, "items to new SRS format...");
                const migratedItems = itemsToLoad.map(item => ({
                    ...item,
                    srs: migrateSRSData(item.srs)
                }));
                setSavedItems(migratedItems);
                await saveData(migratedItems);
                console.log("✅ SRS migration complete!");
            } else {
                setSavedItems(itemsToLoad);
            }
        } catch (e) {
            console.error("Failed to initialize storage", e);
        } finally {
            setIsLoaded(true);
        }
    };
    initStorage();
  }, []);

  // 2. FIREBASE SYNC LOGIC
  useEffect(() => {
    if (!isFirebaseConfigured) return;

    // Handle OAuth redirect result (for iOS Safari)
    handleRedirectResult().catch((error) => {
      if (error?.code === 'auth/unauthorized-domain') {
        setUnauthorizedDomain(window.location.host || window.location.origin || "Unable to detect URL");
      } else if (error) {
        console.error("Redirect result error:", error);
      }
    });

    let unsubscribeData: (() => void) | undefined;

    const unsubscribeAuth = subscribeToAuth((currentUser) => {
      setUser(currentUser);
      
      // Clean up previous data subscription if it exists
      if (unsubscribeData) {
        unsubscribeData();
        unsubscribeData = undefined;
      }
      
      if (currentUser) {
        console.log("🔥 Setting up Firebase sync for user:", currentUser.uid);
        unsubscribeData = subscribeToUserData(currentUser.uid, (remoteItems) => {
            console.log("🔥 📥 Received items from Firebase:", remoteItems.length);
            
            setSavedItems(prevLocal => {
                console.log("🔥 📊 Merging - Remote:", remoteItems.length, "Local:", prevLocal.length);
                const merged = mergeDatasets(prevLocal, remoteItems);
                console.log("🔥 ✅ After merge:", merged.length, "items");
                return merged;
            });
        });
      }
    });

    return () => {
      console.log("🔥 Cleaning up Firebase subscriptions");
      if (unsubscribeData) unsubscribeData();
      unsubscribeAuth();
    };
  }, [isFirebaseConfigured]);

  // 3. SAVE EFFECTS (Persistence)
  useEffect(() => {
    if (!isLoaded) return; 

    const timer = setTimeout(async () => {
      // 1. Save to Local IDB
      await saveData(savedItems);
      console.log("💾 Saved to IndexedDB:", savedItems.length, "items");
      
      // 2. Push to Cloud (Firebase) - OPTIMIZED
      if (user && isFirebaseConfigured) {
          // Get last sync timestamp from localStorage
          const lastSyncKey = `last_sync_${user.uid}`;
          const lastSyncTime = parseInt(localStorage.getItem(lastSyncKey) || '0', 10);
          
          // Only sync items that have changed since last sync
          const itemsToSync = savedItems.filter(item => {
              const itemTime = item.updatedAt || item.savedAt || 0;
              return itemTime > lastSyncTime;
          });
          
          // Only sync if there are actual changes
          if (itemsToSync.length > 0) {
              console.log(`🔥 Syncing ${itemsToSync.length} changed items (out of ${savedItems.length} total)...`);
              setSyncStatus('syncing');
              saveUserData(user.uid, itemsToSync)
                .then(() => {
                  console.log("🔥 Firebase sync complete!");
                  localStorage.setItem(lastSyncKey, Date.now().toString());
                  setSyncStatus('saved');
                })
                .catch((e) => {
                  console.error("🔥 Firebase sync error:", e);
                  setSyncStatus('error');
                });
          } else {
              console.log("🔥 No changes to sync - skipping Firebase request");
          }
      }

    }, 3000); // 3s debounce (increased from 2s)

    return () => clearTimeout(timer);
  }, [savedItems, isLoaded, user, isFirebaseConfigured]);

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
    setSavedItems(prev => {
        if (!Array.isArray(prev)) return [item];
        try {
            if (!item || !item.data || !item.data.id) return prev;
            const rawTitle = getItemTitle(item);
            const incomingTitle = String(rawTitle || '').toLowerCase().trim();
            if (!incomingTitle) return prev; 
            
            const itemToSave = { 
                ...item, 
                updatedAt: Date.now(),
                isDeleted: false 
            };

            const existingIndex = prev.findIndex(i => 
                String(getItemTitle(i) || '').toLowerCase().trim() === incomingTitle
            );

            if (existingIndex >= 0) {
                const existingItem = prev[existingIndex];
                const dataId = (existingItem.data as any)?.id || itemToSave.data.id;
                const mergedSrs = ensureSRSData(
                    existingItem.srs ?? itemToSave.srs,
                    dataId,
                    existingItem.type
                );

                const mergedItem: StoredItem = {
                    ...itemToSave,
                    savedAt: existingItem.savedAt || Date.now(),
                    srs: mergedSrs
                };

                const newItems = [...prev];
                newItems.splice(existingIndex, 1);
                return [mergedItem, ...newItems];
            }
            const normalizedSRS = ensureSRSData(
                itemToSave.srs,
                itemToSave.data.id,
                itemToSave.type
            );
            return [{ ...itemToSave, srs: normalizedSRS }, ...prev];
        } catch (err) {
            console.error("Error during save operation:", err);
            return prev;
        }
    });
  };

  const handleUpdateStoredItem = (item: StoredItem) => {
      setSavedItems(prev => {
          const rawTitle = getItemTitle(item);
          const incomingTitle = String(rawTitle || '').toLowerCase().trim();
          if (!incomingTitle) return prev;
          
          const updatedItemData = { ...item.data };

          return prev.map(existing => {
              const existingTitle = String(getItemTitle(existing) || '').toLowerCase().trim();
              if (existingTitle === incomingTitle) {
                  return { 
                      ...existing, 
                      data: { ...existing.data, ...updatedItemData },
                      updatedAt: Date.now(),
                      isDeleted: false
                  };
              }
              return existing;
          });
      });
  };

  const handleDelete = (id: string) => {
    setSavedItems(prev => prev.map(i => {
        if (i.data?.id === id) {
            return { ...i, isDeleted: true, updatedAt: Date.now() };
        }
        return i;
    }));
  };

  const handleRecursiveSearch = (text: string) => {
      setRecursiveQuery(text);
      setSelectedStoredItem(undefined);
      setCurrentView('search');
      setDetailItem(null); 
  };

  const handleViewStoredItem = (item: StoredItem) => {
      setDetailItem({ data: item.data, type: item.type });
  };

  // Enhanced SRS update with new algorithm
  const updateSRS = (itemId: string, quality: number, taskType: TaskType = 'recall', responseTime: number = 3000) => {
      setSavedItems(prev => prev.map(item => {
          if (!item.data || item.data.id !== itemId) return item;
          
          // Migrate old SRS data if needed
          const migratedSRS = migrateSRSData(item.srs);
          
          // Use new algorithm
          const updatedSRS = SRSAlgorithm.updateAfterReview(
            migratedSRS,
            quality,
            taskType,
            responseTime
          );

          return {
              ...item,
              updatedAt: Date.now(), 
              srs: updatedSRS
          };
      }));
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

      {detailItem && (
          <DetailView 
              data={detailItem.data}
              type={detailItem.type}
              onClose={() => setDetailItem(null)}
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
                onViewDetail={(data, type) => setDetailItem({ data, type })}
                onScroll={handleScroll}
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
