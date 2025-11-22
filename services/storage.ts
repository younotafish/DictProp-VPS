
import { StoredItem } from '../types';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
const DATA_KEY = 'user_items';

const getDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject(new Error("IndexedDB not supported"));
        return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
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
    return [];
  }
};

export const saveData = async (items: StoredItem[]): Promise<void> => {
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
    throw error;
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
