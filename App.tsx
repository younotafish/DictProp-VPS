
import React, { useState, useEffect, useRef } from 'react';
import { SearchView } from './views/Search';
import { NotebookView } from './views/Notebook';
import { StudyView } from './views/Study';
import { DetailView } from './views/DetailView';
import { StoredItem, ViewState, VocabCard, SRSData, SearchResult, SyncConfig, SyncStatus } from './types';
import { Search, Book, BrainCircuit } from 'lucide-react';
import { loadData, saveData, migrateFromLocalStorage } from './services/storage';
import { mergeDatasets } from './services/sync';
import { subscribeToAuth, subscribeToUserData, saveUserData, signIn, signInAnonymouslyUser, signOut, isConfigured } from './services/firebase';
import { syncWithCustomServer } from './services/restSync';
import { FirebaseConfigModal } from './components/FirebaseConfigModal';
import { SyncSettingsModal } from './components/SyncSettingsModal';
import { AuthDomainErrorModal } from './components/AuthDomainErrorModal';
import { ErrorModal } from './components/ErrorModal';

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
  
  // Sync Configuration
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(() => {
      const saved = localStorage.getItem('popdict_sync_config');
      return saved ? JSON.parse(saved) : { type: 'firebase', enabled: true, lastSynced: 0 };
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');

  // Auth States (Firebase)
  const [user, setUser] = useState<any | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
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

  // Save Sync Config
  useEffect(() => {
      localStorage.setItem('popdict_sync_config', JSON.stringify(syncConfig));
  }, [syncConfig]);

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

  // 1. Initialize Local Storage (Load from IndexedDB)
  useEffect(() => {
    const initStorage = async () => {
        try {
            const migrated = await migrateFromLocalStorage();
            if (migrated && migrated.length > 0) {
                setSavedItems(migrated);
            } else {
                const items = await loadData();
                if (items && Array.isArray(items)) {
                    const validItems = items.filter((i: any) => 
                        i && i.data && i.data.id && i.srs && i.type && !i.isDeleted
                    );
                    setSavedItems(validItems);
                }
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
    if (syncConfig.type !== 'firebase' || !isFirebaseConfigured) return;

    const unsubscribeAuth = subscribeToAuth((currentUser) => {
      setUser(currentUser);
      
      if (currentUser) {
        const unsubscribeData = subscribeToUserData(currentUser.uid, (remoteItems) => {
            if (!remoteItems) return;
            setSavedItems(prevLocal => {
                const merged = mergeDatasets(prevLocal, remoteItems);
                if (JSON.stringify(merged) !== JSON.stringify(prevLocal)) {
                     return merged;
                }
                return prevLocal;
            });
        });
        return () => unsubscribeData();
      }
    });
    return () => unsubscribeAuth();
  }, [syncConfig.type, isFirebaseConfigured]);

  // 3. CUSTOM SERVER SYNC LOGIC (Polling)
  useEffect(() => {
      if (syncConfig.type !== 'custom' || !syncConfig.serverUrl || !isLoaded) return;

      const runCustomSync = async () => {
          setSyncStatus('syncing');
          try {
              const { items, hasChanges } = await syncWithCustomServer(syncConfig.serverUrl!, syncConfig.apiKey, savedItems);
              if (hasChanges) {
                  setSavedItems(items);
                  setSyncStatus('saved');
              } else {
                  setSyncStatus('idle');
              }
          } catch (e) {
              setSyncStatus('error');
              console.error("Custom sync failed", e);
          }
      };

      // Initial sync
      runCustomSync();

      // Poll every 60 seconds
      const interval = setInterval(runCustomSync, 60000);
      return () => clearInterval(interval);
  }, [syncConfig, isLoaded]); // Dependency on syncConfig ensures it restarts if URL changes

  // 4. SAVE EFFECTS (Persistence)
  useEffect(() => {
    if (!isLoaded) return; 

    const timer = setTimeout(async () => {
      // 1. Save to Local IDB
      await saveData(savedItems);
      
      // 2. Push to Cloud (Firebase)
      if (syncConfig.type === 'firebase' && user && isFirebaseConfigured) {
          setSyncStatus('syncing');
          saveUserData(user.uid, savedItems)
            .then(() => setSyncStatus('saved'))
            .catch(() => setSyncStatus('error'));
      }

      // 3. Push to Cloud (Custom)
      // handled by the polling effect or immediate trigger?
      // Let's trigger an immediate push if in custom mode
      if (syncConfig.type === 'custom' && syncConfig.serverUrl) {
          setSyncStatus('syncing');
          try {
             await syncWithCustomServer(syncConfig.serverUrl, syncConfig.apiKey, savedItems);
             setSyncStatus('saved');
          } catch (e) {
             setSyncStatus('error');
          }
      }

    }, 2000); // 2s debounce

    return () => clearTimeout(timer);
  }, [savedItems, isLoaded, user, isFirebaseConfigured, syncConfig]);

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
                const existingSrs = existingItem.srs; 
                const mergedSrs: SRSData = {
                    id: itemToSave.data.id,
                    type: itemToSave.type,
                    interval: (existingSrs?.interval ?? itemToSave.srs?.interval ?? 0),
                    easeFactor: (existingSrs?.easeFactor ?? itemToSave.srs?.easeFactor ?? 2.5),
                    nextReview: (existingSrs?.nextReview ?? itemToSave.srs?.nextReview ?? Date.now()),
                    history: (existingSrs && Array.isArray(existingSrs.history)) ? existingSrs.history : []
                };

                const mergedItem: StoredItem = {
                    ...itemToSave,
                    savedAt: existingItem.savedAt || Date.now(),
                    srs: mergedSrs
                };

                const newItems = [...prev];
                newItems.splice(existingIndex, 1);
                return [mergedItem, ...newItems];
            }
            return [itemToSave, ...prev];
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
  
  const handleImport = (importedItems: StoredItem[]) => {
      if (!importedItems || importedItems.length === 0) return;
      const preparedItems = importedItems.map(i => ({
          ...i, 
          updatedAt: i.updatedAt || i.savedAt || Date.now(),
          isDeleted: false
      }));
      setSavedItems(prev => mergeDatasets(prev, preparedItems));
      alert(`Import successful!`);
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

  const updateSRS = (itemId: string, quality: number) => {
      setSavedItems(prev => prev.map(item => {
          if (!item.data || item.data.id !== itemId) return item;
          
          const oldHistory = Array.isArray(item.srs.history) ? item.srs.history : [];
          const newHistory = [...oldHistory, quality];
          
          let streak = 0;
          for (let i = newHistory.length - 1; i >= 0; i--) {
            if (newHistory[i] >= 3) streak++;
            else break;
          }

          let newInterval = item.srs.interval;
          let newEase = item.srs.easeFactor;

          if (quality >= 3) {
              const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
              newEase += delta;
              if (newInterval === 0) newInterval = 1;
              else if (newInterval === 1) newInterval = 10;
              else {
                  let growthMultiplier = newEase;
                  if (quality === 3) growthMultiplier = Math.max(1.2, growthMultiplier * 0.85);
                  if (quality === 5 && streak > 3) growthMultiplier *= 1.2; 
                  newInterval = Math.round(newInterval * growthMultiplier);
              }
              if (streak > 8 && quality === 5) newEase += 0.05;
          } else {
              newInterval = 0; 
              if (streak > 5) newEase -= 0.15; 
              else if (streak > 2) newEase -= 0.25; 
              else newEase -= 0.35; 
          }

          if (newEase < 1.3) newEase = 1.3; 
          if (newEase > 3.5) newEase = 3.5; 

          const minuteMultiplier = 60 * 1000; 
          const nextReview = Date.now() + (newInterval * minuteMultiplier);

          return {
              ...item,
              updatedAt: Date.now(), 
              srs: {
                  ...item.srs,
                  interval: newInterval,
                  easeFactor: newEase,
                  nextReview: nextReview,
                  history: newHistory
              }
          };
      }));
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
    <div className="fixed inset-0 bg-white shadow-2xl overflow-hidden flex flex-col relative touch-pan-y">
      {showSettingsModal && (
          <SyncSettingsModal 
            config={syncConfig} 
            onSave={setSyncConfig} 
            onClose={() => setShowSettingsModal(false)} 
          />
      )}
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
        className="flex-1 overflow-hidden relative w-full touch-pan-y"
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
            />
        </div>
        
        {currentView === 'notebook' && (
          <NotebookView 
            items={savedItems.filter(i => !i.isDeleted)} 
            onDelete={handleDelete} 
            onSearch={handleRecursiveSearch} 
            onViewDetail={handleViewStoredItem}
            onImport={handleImport}
            user={user}
            onSignIn={handleSignIn}
            onGuestSignIn={handleGuestSignIn}
            onSignOut={handleSignOut}
            onSetup={() => setShowSettingsModal(true)}
            isConfigured={isFirebaseConfigured}
            syncStatus={syncStatus}
          />
        )}
        
        {currentView === 'study' && (
          <StudyView 
            items={savedItems.filter(i => !i.isDeleted)} 
            onUpdateSRS={updateSRS}
            onSearch={handleRecursiveSearch} 
            onDelete={handleDelete}
          />
        )}
      </main>

      <nav className="bg-white border-t border-slate-200 flex justify-between px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 z-30 shadow-[0_-1px_3px_rgba(0,0,0,0.05)] shrink-0">
        <NavButton view="search" icon={Search} label="Search" />
        <NavButton view="notebook" icon={Book} label="Notebook" />
        <NavButton view="study" icon={BrainCircuit} label="Study" />
      </nav>
    </div>
  );
};

export default App;
