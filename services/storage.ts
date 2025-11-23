
import { StoredItem } from '../types';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
const DATA_KEY = 'user_items';

// Fallback storage for iOS Safari private mode (where IndexedDB may not work)
let inMemoryStorage: StoredItem[] | null = null;
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

export const loadData = async (): Promise<StoredItem[]> => {
  const idbAvailable = await checkIndexedDBAvailability();
  
  if (!idbAvailable) {
    console.warn("IndexedDB not available, using in-memory storage (iOS Safari private mode?)");
    // Try to load from localStorage as fallback
    try {
      const localData = localStorage.getItem('popdict_items_fallback');
      if (localData) {
        const parsed = JSON.parse(localData);
        if (Array.isArray(parsed)) {
          inMemoryStorage = parsed;
          return parsed;
        }
      }
    } catch (e) {
      console.warn("Failed to load from localStorage fallback", e);
    }
    return inMemoryStorage || [];
  }
  
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(DATA_KEY);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("IDB Load Error", error);
    // Fall back to in-memory storage
    return inMemoryStorage || [];
  }
};

export const saveData = async (items: StoredItem[]): Promise<void> => {
  const idbAvailable = await checkIndexedDBAvailability();
  
  if (!idbAvailable) {
    console.warn("IndexedDB not available, saving to in-memory storage");
    inMemoryStorage = items;
    // Also try to save to localStorage as a fallback persistence layer
    try {
      localStorage.setItem('popdict_items_fallback', JSON.stringify(items));
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
      const request = store.put(items, DATA_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("IDB Save Error", error);
    // Fall back to in-memory storage
    inMemoryStorage = items;
    try {
      localStorage.setItem('popdict_items_fallback', JSON.stringify(items));
    } catch (e) {
      console.warn("Failed to save to localStorage fallback", e);
    }
  }
};

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

// --- SHAREABLE STORAGE UTILS ---

export const exportBackup = (items: StoredItem[]) => {
  const dataStr = JSON.stringify(items, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `popdict_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const validateBackup = async (file: File): Promise<StoredItem[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        if (Array.isArray(json)) {
             // Basic validation: Check if items look like StoredItems
             const valid = json.every(i => i.data && i.data.id && i.type);
             if (valid) resolve(json);
             else reject(new Error("Invalid backup format: Missing required fields."));
        } else {
            reject(new Error("Invalid backup format: Not an array."));
        }
      } catch (err) {
        reject(new Error("Failed to parse JSON file."));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
};
