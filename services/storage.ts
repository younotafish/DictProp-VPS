
import { StoredItem } from '../types';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
// Base key - will be suffixed with userId
const BASE_DATA_KEY = 'items';

// Helper to get key for a specific user
const getStorageKey = (userId: string = 'guest') => `${BASE_DATA_KEY}_${userId}`;

// Fallback storage for iOS Safari private mode
let inMemoryStorage: Record<string, StoredItem[]> = {};
let indexedDBAvailable: boolean | null = null;

const checkIndexedDBAvailability = async (): Promise<boolean> => {
  if (indexedDBAvailable !== null) return indexedDBAvailable;
  
  if (typeof indexedDB === 'undefined') {
    indexedDBAvailable = false;
    return false;
  }
  
  try {
    // Try to open a test database to check if IndexedDB actually works
    // (it may be disabled in iOS Safari private mode)
    const testDB = await new Promise<boolean>((resolve) => {
      const request = indexedDB.open('__test__');
      request.onsuccess = () => {
        request.result.close();
        indexedDB.deleteDatabase('__test__');
        resolve(true);
      };
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    });
    indexedDBAvailable = testDB;
    return testDB;
  } catch {
    indexedDBAvailable = false;
    return false;
  }
};

const getDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject(new Error("IndexedDB not supported"));
        return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => {
      console.warn("IndexedDB open failed, will use in-memory fallback");
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
};

export const loadData = async (userId: string = 'guest'): Promise<StoredItem[]> => {
  const idbAvailable = await checkIndexedDBAvailability();
  const storageKey = getStorageKey(userId);
  
  if (!idbAvailable) {
    console.warn("IndexedDB not available, using in-memory storage (iOS Safari private mode?)");
    // Try to load from localStorage as fallback
    try {
      const localData = localStorage.getItem(`popdict_items_fallback_${userId}`);
      if (localData) {
        const parsed = JSON.parse(localData);
        if (Array.isArray(parsed)) {
          // Validate items have required properties
          const validItems = parsed.filter((i: any) => 
            i && i.data && i.data.id && i.type
          );
          inMemoryStorage[userId] = validItems;
          return validItems;
        }
      }
    } catch (e) {
      console.warn("Failed to load from localStorage fallback", e);
    }
    return inMemoryStorage[userId] || [];
  }
  
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(storageKey);
      
      request.onsuccess = () => {
        const data = request.result;
        
        // Validate loaded data
        if (data && Array.isArray(data)) {
          const validItems = data.filter((i: any) => 
            i && i.data && i.data.id && i.type
          );
          
          // MIGRATION: If specific user data not found, check for legacy "user_items"
          if (validItems.length === 0 && userId === 'guest') {
            const legacyRequest = store.get('user_items');
            legacyRequest.onsuccess = () => {
              if (legacyRequest.result && Array.isArray(legacyRequest.result)) {
                console.log("📦 Found legacy data, migrating to guest storage...");
                const validLegacy = legacyRequest.result.filter((i: any) => 
                  i && i.data && i.data.id && i.type
                );
                resolve(validLegacy);
              } else {
                resolve([]);
              }
            };
            legacyRequest.onerror = () => resolve([]);
            return;
          }
          
          resolve(validItems);
        } else if (!data && userId === 'guest') {
          // Try legacy migration
          const legacyRequest = store.get('user_items');
          legacyRequest.onsuccess = () => {
            if (legacyRequest.result && Array.isArray(legacyRequest.result)) {
              console.log("📦 Found legacy data, migrating to guest storage...");
              const validLegacy = legacyRequest.result.filter((i: any) => 
                i && i.data && i.data.id && i.type
              );
              resolve(validLegacy);
            } else {
              resolve([]);
            }
          };
          legacyRequest.onerror = () => resolve([]);
        } else {
          resolve([]);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("IDB Load Error", error);
    // Fall back to in-memory storage
    return inMemoryStorage[userId] || [];
  }
};

export const saveData = async (items: StoredItem[], userId: string = 'guest'): Promise<void> => {
  const idbAvailable = await checkIndexedDBAvailability();
  const storageKey = getStorageKey(userId);
  
  if (!idbAvailable) {
    console.warn("IndexedDB not available, saving to in-memory storage");
    inMemoryStorage[userId] = items;
    // Also try to save to localStorage as a fallback persistence layer
    try {
      localStorage.setItem(`popdict_items_fallback_${userId}`, JSON.stringify(items));
    } catch (e) {
      console.warn("Failed to save to localStorage fallback (quota exceeded?)", e);
    }
    return;
  }
  
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(items, storageKey);
      request.onsuccess = () => {
          // If we successfully saved to the new key, and we were saving guest data,
          // we might want to clean up legacy data? 
          // Let's keep it simple for now.
          resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("IDB Save Error", error);
    // Fall back to in-memory storage
    inMemoryStorage[userId] = items;
    try {
      localStorage.setItem(`popdict_items_fallback_${userId}`, JSON.stringify(items));
    } catch (e) {
      console.warn("Failed to save to localStorage fallback", e);
    }
  }
};

// ============================================
// DEPRECATED: OPERATION STORAGE REMOVED
// ============================================
// Operation-based sync was removed due to Firestore 1MB document limit.
// Items are now synced directly using the items collection.

// ============================================
// LEGACY MIGRATION
// ============================================

// Check if old localStorage data exists and move it to IDB
export const migrateFromLocalStorage = async (): Promise<StoredItem[] | null> => {
    const localData = localStorage.getItem('popdict_items');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (Array.isArray(parsed)) {
                console.log("Migrating data from LocalStorage to IndexedDB...");
                await saveData(parsed);
                localStorage.removeItem('popdict_items'); // Clear old storage
                return parsed;
            }
        } catch (e) {
            console.warn("Migration failed", e);
        }
    }
    return null;
};

