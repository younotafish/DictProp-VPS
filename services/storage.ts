import { StoredItem } from '../types';
import { dataUriToBlob } from './dataUri';
import { log, warn, error as logError } from './logger';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
const ITEM_UPDATES_STORE = 'item_updates';
const ITEM_RECORDS_STORE = 'items_v2';
const DB_VERSION = 4;

// Base key - will be suffixed with userId
const BASE_DATA_KEY = 'items';

// Helper to get key for a specific user
const getStorageKey = (userId: string = 'vps') => `${BASE_DATA_KEY}_${userId}`;

// Fallback storage for iOS Safari private mode
let inMemoryStorage: Record<string, StoredItem[]> = {};
let indexedDBAvailable: boolean | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;
const persistedFingerprints = new Map<string, Map<string, string>>();

const itemFingerprint = (item: StoredItem): string => JSON.stringify(item);

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
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject(new Error("IndexedDB not supported"));
        return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      warn("IndexedDB open failed, will use in-memory fallback");
      reject(request.error);
    };
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
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

      // Bounded compatibility journal. One record per item lets a v3 rollback read
      // changes made after v4 without rewriting the legacy full-array snapshot.
      if (!db.objectStoreNames.contains(ITEM_UPDATES_STORE)) {
        const updates = db.createObjectStore(ITEM_UPDATES_STORE, { keyPath: 'key' });
        updates.createIndex('userId', 'userId');
      }

      // Primary v4 storage: one IndexedDB record per library item.
      if (!db.objectStoreNames.contains(ITEM_RECORDS_STORE)) {
        const items = db.createObjectStore(ITEM_RECORDS_STORE, { keyPath: 'key' });
        items.createIndex('userId', 'userId');
      }
    };
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
};

const loadSnapshot = async (userId: string = 'vps'): Promise<StoredItem[]> => {
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

const loadItemUpdates = async (userId: string): Promise<StoredItem[]> => {
  if (!(await checkIndexedDBAvailability())) return [];
  try {
    const db = await getDB();
    return await new Promise<StoredItem[]>((resolve, reject) => {
      const tx = db.transaction(ITEM_UPDATES_STORE, 'readonly');
      const request = tx.objectStore(ITEM_UPDATES_STORE).index('userId').getAll(userId);
      request.onsuccess = () => resolve(
        (request.result as Array<{ item?: StoredItem }>).map(record => record.item).filter(Boolean) as StoredItem[],
      );
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    warn('Failed to load pending item updates', error);
    return [];
  }
};

const loadItemRecords = async (userId: string): Promise<StoredItem[]> => {
  if (!(await checkIndexedDBAvailability())) return [];
  try {
    const db = await getDB();
    return await new Promise<StoredItem[]>((resolve, reject) => {
      const tx = db.transaction(ITEM_RECORDS_STORE, 'readonly');
      const request = tx.objectStore(ITEM_RECORDS_STORE).index('userId').getAll(userId);
      request.onsuccess = () => resolve(
        (request.result as Array<{ item?: StoredItem }>).map(record => record.item).filter(Boolean) as StoredItem[],
      );
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    warn('Failed to load per-item records', error);
    return [];
  }
};

const writeItemRecords = async (
  items: readonly StoredItem[],
  userId: string,
  includeCompatibilityJournal: boolean,
): Promise<void> => {
  if (items.length === 0) return;
  const db = await getDB();
  const stores = includeCompatibilityJournal
    ? [ITEM_RECORDS_STORE, ITEM_UPDATES_STORE]
    : [ITEM_RECORDS_STORE];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    const records = tx.objectStore(ITEM_RECORDS_STORE);
    const updates = includeCompatibilityJournal ? tx.objectStore(ITEM_UPDATES_STORE) : null;
    for (const item of items) {
      const record = { key: `${userId}:${item.data.id}`, userId, item };
      records.put(record);
      updates?.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const loadData = async (userId: string = 'vps'): Promise<StoredItem[]> => {
  const [snapshot, records, updates] = await Promise.all([
    loadSnapshot(userId),
    loadItemRecords(userId),
    loadItemUpdates(userId),
  ]);
  const byId = new Map(snapshot.map(item => [item.data.id, item]));
  for (const item of records) byId.set(item.data.id, item);
  for (const item of updates) byId.set(item.data.id, item);
  const merged = Array.from(byId.values());

  // Lazy, idempotent v3 -> v4 migration. A failed migration is retried on the next save/load.
  const recordFingerprints = new Map(records.map(item => [item.data.id, itemFingerprint(item)]));
  const missingOrChanged = merged.filter(item => recordFingerprints.get(item.data.id) !== itemFingerprint(item));
  if (missingOrChanged.length > 0 && await checkIndexedDBAvailability()) {
    try {
      await writeItemRecords(missingOrChanged, userId, false);
      for (const item of missingOrChanged) recordFingerprints.set(item.data.id, itemFingerprint(item));
    } catch (error) {
      warn('Per-item storage migration will retry', error);
    }
  }
  persistedFingerprints.set(userId, recordFingerprints);
  return merged;
};

/** Persist a small set of changed items immediately without rewriting the full library snapshot. */
export const saveItemUpdates = async (
  items: StoredItem[],
  userId: string = 'vps',
): Promise<void> => {
  if (items.length === 0) return;
  if (!(await checkIndexedDBAvailability())) {
    const byId = new Map((inMemoryStorage[userId] || []).map(item => [item.data.id, item]));
    for (const item of items) byId.set(item.data.id, item);
    inMemoryStorage[userId] = Array.from(byId.values());
    return;
  }
  await writeItemRecords(items, userId, true);
  const fingerprints = persistedFingerprints.get(userId) || new Map<string, string>();
  for (const item of items) fingerprints.set(item.data.id, itemFingerprint(item));
  persistedFingerprints.set(userId, fingerprints);
};

export const saveData = async (items: StoredItem[], userId: string = 'vps'): Promise<void> => {
  const idbAvailable = await checkIndexedDBAvailability();
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
    const fingerprints = persistedFingerprints.get(userId) || new Map<string, string>();
    const changed = items.filter(item => fingerprints.get(item.data.id) !== itemFingerprint(item));
    if (changed.length === 0) return;
    await writeItemRecords(changed, userId, true);
    for (const item of changed) fingerprints.set(item.data.id, itemFingerprint(item));
    persistedFingerprints.set(userId, fingerprints);
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

const blobToDataUri = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const evictImageCache = () => {
  if (imageCache.size <= IMAGE_CACHE_MAX) return;
  // Delete oldest entry (first key)
  const firstKey = imageCache.keys().next().value;
  if (firstKey) {
    const value = imageCache.get(firstKey);
    if (value?.startsWith('blob:')) URL.revokeObjectURL(value);
    imageCache.delete(firstKey);
  }
};

export const saveImage = async (itemId: string, base64: string): Promise<void> => {
  const blob = dataUriToBlob(base64);
  const cachedUrl = URL.createObjectURL(blob);
  imageCache.set(itemId, cachedUrl);
  evictImageCache();

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      store.put(blob, itemId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to save image to IDB", e);
  }
};

export const saveImagesBatch = async (images: Array<{ id: string; base64: string }>): Promise<void> => {
  if (images.length === 0) return;
  const encoded = images.map(image => ({ ...image, blob: dataUriToBlob(image.base64) }));

  // Populate cache
  for (const img of encoded) {
    imageCache.set(img.id, URL.createObjectURL(img.blob));
  }
  // Trim cache to limit
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey) {
      const value = imageCache.get(firstKey);
      if (value?.startsWith('blob:')) URL.revokeObjectURL(value);
      imageCache.delete(firstKey);
    }
  }

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      for (const img of encoded) {
        store.put(img.blob, img.id);
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
        const result = request.result as string | Blob | undefined;
        if (result) {
          const url = result instanceof Blob ? URL.createObjectURL(result) : result;
          imageCache.set(itemId, url);
          evictImageCache();
          resolve(url);
          return;
        }
        resolve(null);
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
 * Enumerate ALL image ids currently stored in IDB (the keys of the images store).
 * Used by the "restore images to server" recovery action to diff against the server.
 */
export const getAllStoredImageIds = async (): Promise<Set<string>> => {
  const found = new Set<string>();
  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return found;

  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result as IDBValidKey[]) {
          if (typeof k === 'string') found.add(k);
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    warn("Failed to enumerate stored image ids", e);
  }
  return found;
};

/** Batch-load base64 data URIs from IDB for the given ids (missing ids are omitted). */
export const loadImagesByIds = async (ids: string[]): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return result;

  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      let pending = ids.length;
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          const value = req.result;
          if (typeof value === 'string') result.set(id, value);
          if (value instanceof Blob) {
            blobToDataUri(value).then(dataUri => result.set(id, dataUri)).finally(() => {
              if (--pending === 0) resolve();
            });
            return;
          }
          if (--pending === 0) resolve();
        };
        req.onerror = () => { if (--pending === 0) resolve(); };
      }
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to load images by ids", e);
  }
  return result;
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
