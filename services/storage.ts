import { StoredItem } from '../types';
import { log, warn, error as logError } from './logger';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
const DB_VERSION = 2; // Keep at 2 for compatibility

// Base key - will be suffixed with userId
const BASE_DATA_KEY = 'items';

// Helper to get key for a specific user
const getStorageKey = (userId: string = 'vps') => `${BASE_DATA_KEY}_${userId}`;

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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      warn("IndexedDB open failed, will use in-memory fallback");
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create library store (v1)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      
      // Images store (v2) - kept for compatibility but not actively used
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images');
      }
    };
  });
};

export const loadData = async (userId: string = 'vps'): Promise<StoredItem[]> => {
  const idbAvailable = await checkIndexedDBAvailability();
  const storageKey = getStorageKey(userId);
  
  if (!idbAvailable) {
    warn("IndexedDB not available, using in-memory storage (iOS Safari private mode?)");
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
      warn("Failed to load from localStorage fallback", e);
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
                log("📦 Found legacy data, migrating to guest storage...");
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
              log("📦 Found legacy data, migrating to guest storage...");
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
    logError("IDB Load Error", error);
    // Fall back to in-memory storage
    return inMemoryStorage[userId] || [];
  }
};

export const saveData = async (items: StoredItem[], userId: string = 'vps'): Promise<void> => {
  const idbAvailable = await checkIndexedDBAvailability();
  const storageKey = getStorageKey(userId);
  
  if (!idbAvailable) {
    warn("IndexedDB not available, saving to in-memory storage");
    inMemoryStorage[userId] = items;
    // Also try to save to localStorage as a fallback persistence layer
    try {
      localStorage.setItem(`popdict_items_fallback_${userId}`, JSON.stringify(items));
    } catch (e) {
      warn("Failed to save to localStorage fallback (quota exceeded?)", e);
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
          resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    logError("IDB Save Error", error);
    // Fall back to in-memory storage
    inMemoryStorage[userId] = items;
    try {
      localStorage.setItem(`popdict_items_fallback_${userId}`, JSON.stringify(items));
    } catch (e) {
      warn("Failed to save to localStorage fallback", e);
    }
  }
};

// --- Image Store (offloaded from React state to IDB) ---

const IMAGES_STORE = 'images';

// In-memory LRU cache for frequently accessed images
const imageCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 50;

const evictImageCache = () => {
  if (imageCache.size <= IMAGE_CACHE_MAX) return;
  // Delete oldest entry (first key)
  const firstKey = imageCache.keys().next().value;
  if (firstKey) imageCache.delete(firstKey);
};

export const saveImage = async (itemId: string, base64: string): Promise<void> => {
  imageCache.set(itemId, base64);
  evictImageCache();

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      store.put(base64, itemId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to save image to IDB", e);
  }
};

export const saveImagesBatch = async (images: Array<{ id: string; base64: string }>): Promise<void> => {
  if (images.length === 0) return;

  // Populate cache
  for (const img of images) {
    imageCache.set(img.id, img.base64);
  }
  // Trim cache to limit
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey) imageCache.delete(firstKey);
  }

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      for (const img of images) {
        store.put(img.base64, img.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to batch save images to IDB", e);
  }
};

export const loadImage = async (itemId: string): Promise<string | null> => {
  // Check in-memory cache first
  const cached = imageCache.get(itemId);
  if (cached) {
    // Move to end (most recently used)
    imageCache.delete(itemId);
    imageCache.set(itemId, cached);
    return cached;
  }

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return null;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      const request = store.get(itemId);
      request.onsuccess = () => {
        const result = request.result as string | undefined;
        if (result) {
          imageCache.set(itemId, result);
          evictImageCache();
        }
        resolve(result || null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    warn("Failed to load image from IDB", e);
    return null;
  }
};

/**
 * Check which of the given IDs already have images stored in IDB.
 * Returns the set of IDs that DO have images (i.e., don't need fetching).
 */
export const getStoredImageIds = async (ids: string[]): Promise<Set<string>> => {
  const found = new Set<string>();
  if (ids.length === 0) return found;

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return found;

  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      let pending = ids.length;
      for (const id of ids) {
        // Use getKey instead of get to avoid loading the full base64 into memory
        const req = store.getKey(id);
        req.onsuccess = () => {
          if (req.result !== undefined) found.add(id);
          if (--pending === 0) resolve();
        };
        req.onerror = () => {
          if (--pending === 0) resolve();
        };
      }
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to check stored image IDs", e);
  }
  return found;
};

/**
 * Restore base64 images from IDB into items before pushing to server.
 * Replaces 'idb:stored' markers with actual base64 data so the server stores real images.
 */
export const rehydrateImagesForSync = async (items: StoredItem[]): Promise<StoredItem[]> => {
  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return items;

  // Collect all item IDs that need image rehydration
  const idsToLoad = new Set<string>();
  for (const item of items) {
    const data = item.data as any;
    if (data.imageUrl === 'idb:stored') idsToLoad.add(data.id);
    if (Array.isArray(data.vocabs)) {
      for (const v of data.vocabs) {
        if (v.imageUrl === 'idb:stored') idsToLoad.add(v.id);
      }
    }
  }

  if (idsToLoad.size === 0) return items;

  // Batch load all needed images from IDB
  const imageMap = new Map<string, string>();
  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      let pending = idsToLoad.size;
      for (const id of idsToLoad) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) imageMap.set(id, req.result as string);
          if (--pending === 0) resolve();
        };
        req.onerror = () => {
          if (--pending === 0) resolve();
        };
      }
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to batch load images for sync rehydration", e);
    return items;
  }

  if (imageMap.size === 0) return items;

  // Replace markers with real base64
  return items.map(item => {
    let changed = false;
    let data = item.data as any;

    if (data.imageUrl === 'idb:stored' && imageMap.has(data.id)) {
      data = { ...data, imageUrl: imageMap.get(data.id) };
      changed = true;
    }

    if (Array.isArray(data.vocabs)) {
      let vocabsChanged = false;
      const newVocabs = data.vocabs.map((v: any) => {
        if (v.imageUrl === 'idb:stored' && imageMap.has(v.id)) {
          vocabsChanged = true;
          return { ...v, imageUrl: imageMap.get(v.id) };
        }
        return v;
      });
      if (vocabsChanged) {
        data = { ...data, vocabs: newVocabs };
        changed = true;
      }
    }

    return changed ? { ...item, data } : item;
  });
};

// Legacy Migration: Check if old localStorage data exists and move it to IDB
export const migrateFromLocalStorage = async (): Promise<StoredItem[] | null> => {
    const localData = localStorage.getItem('popdict_items');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (Array.isArray(parsed)) {
                log("Migrating data from LocalStorage to IndexedDB...");
                await saveData(parsed);
                localStorage.removeItem('popdict_items'); // Clear old storage
                return parsed;
            }
        } catch (e) {
            warn("Migration failed", e);
        }
    }
    return null;
};
