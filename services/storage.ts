import { RevisionCursor, StoredItem } from '../types';
import { dataUriToBlob } from './dataUri';
import { getItemContentHash, ITEM_HASH_VERSION, seedItemContentHash } from './itemHash';
import { log, warn, error as logError } from './logger';
import { isSameJson } from './sameJson';

const DB_NAME = 'PopDictDB';
const STORE_NAME = 'library';
const ITEM_UPDATES_STORE = 'item_updates';
const ITEM_RECORDS_STORE = 'items_v2';
const DB_VERSION = 4;

// Builds before per-item records stored each user's library as one array under this key.
const getSnapshotKey = (userId: string) => `items_${userId}`;
// The server revision cursor the stored library is current to, kept beside the snapshot key.
const getCursorKey = (userId: string) => `cursor_${userId}`;

// Fallback storage for iOS Safari private mode
let inMemoryStorage: Record<string, StoredItem[]> = {};
const inMemoryCursors: Record<string, RevisionCursor> = {};
let indexedDBAvailable: boolean | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

// The object last written for each item. Items are replaced rather than mutated when they change, so
// an identity check finds the changed items without serializing the whole library.
const persistedItems = new Map<string, Map<string, StoredItem>>();

// Items loaded from records written before records carried their hash; storeMissingItemHashes adds it.
const unhashedItems = new Map<string, StoredItem[]>();

const rememberPersisted = (userId: string, items: readonly StoredItem[]): void => {
  let persisted = persistedItems.get(userId);
  if (!persisted) persistedItems.set(userId, persisted = new Map());
  for (const item of items) persisted.set(item.data.id, item);
};

const isValidItem = (value: any): value is StoredItem => !!value?.data?.id && !!value.type;

const isRevisionCursor = (value: any): value is RevisionCursor =>
  Number.isSafeInteger(value?.revision) && value.revision >= 0 && typeof value.id === 'string';

interface ItemRecord {
  key: string;
  userId: string;
  item: StoredItem;
  /** Content hash of `item` under hashVersion, so launch doesn't rehash the library. */
  hash?: string;
  hashVersion?: number;
}

const toRecord = (item: StoredItem, userId: string): ItemRecord => ({
  key: `${userId}:${item.data.id}`,
  userId,
  item,
  hash: getItemContentHash(item),
  hashVersion: ITEM_HASH_VERSION,
});

// Record writes run one at a time, so each sees what the writes before it stored.
let writeQueue: Promise<unknown> = Promise.resolve();
const queueWrite = <T,>(write: () => Promise<T>): Promise<T> => {
  const run = writeQueue.then(write, write);
  writeQueue = run.catch(() => {});
  return run;
};

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
      
      // Legacy full-library snapshots (v1); emptied by foldLegacyStores.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      
      // Offloaded item images (v2).
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images');
      }

      // Legacy per-item journal (v3); emptied by foldLegacyStores.
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

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const loadItemRecords = async (
  db: IDBDatabase,
  userId: string,
): Promise<{ items: StoredItem[]; unhashed: StoredItem[]; cursor: RevisionCursor | null }> => {
  const tx = db.transaction([ITEM_RECORDS_STORE, STORE_NAME], 'readonly');
  const [records, cursor] = await Promise.all([
    requestResult(tx.objectStore(ITEM_RECORDS_STORE).index('userId').getAll(userId)),
    requestResult(tx.objectStore(STORE_NAME).get(getCursorKey(userId))),
  ]);
  const items: StoredItem[] = [];
  const unhashed: StoredItem[] = [];
  for (const record of records as Array<Partial<ItemRecord>>) {
    if (!isValidItem(record.item)) continue;
    items.push(record.item);
    if (record.hashVersion === ITEM_HASH_VERSION && typeof record.hash === 'string') {
      seedItemContentHash(record.item, record.hash);
    } else {
      unhashed.push(record.item);
    }
  }
  return { items, unhashed, cursor: isRevisionCursor(cursor) ? cursor : null };
};

const writeItemRecords = async (items: readonly StoredItem[], userId: string): Promise<void> => {
  if (items.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(ITEM_RECORDS_STORE, 'readwrite');
  const records = tx.objectStore(ITEM_RECORDS_STORE);
  for (const item of items) records.put(toRecord(item, userId));
  await transactionDone(tx);
};

/**
 * Older builds kept a full-library snapshot and then a per-item journal beside the records. Fold
 * whatever they still hold into the records once and clear them, so launch reads the library once
 * instead of up to three times. Counting is cheap; the legacy values are read only when present.
 */
const foldLegacyStores = async (db: IDBDatabase, records: StoredItem[], userId: string): Promise<StoredItem[]> => {
  const countTx = db.transaction([STORE_NAME, ITEM_UPDATES_STORE], 'readonly');
  const [snapshotCount, journalCount] = await Promise.all([
    requestResult(countTx.objectStore(STORE_NAME).count(getSnapshotKey(userId))),
    requestResult(countTx.objectStore(ITEM_UPDATES_STORE).index('userId').count(userId)),
  ]);
  if (snapshotCount === 0 && journalCount === 0) return records;

  const readTx = db.transaction([STORE_NAME, ITEM_UPDATES_STORE], 'readonly');
  const [snapshot, journal] = await Promise.all([
    requestResult(readTx.objectStore(STORE_NAME).get(getSnapshotKey(userId))),
    requestResult(readTx.objectStore(ITEM_UPDATES_STORE).index('userId').getAll(userId)),
  ]);
  // Same precedence as when all three were read on every launch: snapshot < records < journal.
  // Journal writes were paired with record writes, so usually nothing here differs from the records.
  const recordsById = new Map(records.map(item => [item.data.id, item]));
  const byId = new Map<string, StoredItem>();
  for (const item of Array.isArray(snapshot) ? snapshot.filter(isValidItem) : []) byId.set(item.data.id, item);
  for (const item of records) byId.set(item.data.id, item);
  for (const { item } of journal as Array<{ item?: StoredItem }>) {
    if (!isValidItem(item)) continue;
    const record = recordsById.get(item.data.id);
    if (!record || !isSameJson(record, item)) byId.set(item.data.id, item);
  }
  const folded = Array.from(byId.values()).filter(item => recordsById.get(item.data.id) !== item);

  // One transaction: the legacy copies are removed only once the records hold everything they had.
  const tx = db.transaction([ITEM_RECORDS_STORE, STORE_NAME, ITEM_UPDATES_STORE], 'readwrite');
  const recordStore = tx.objectStore(ITEM_RECORDS_STORE);
  for (const item of folded) recordStore.put(toRecord(item, userId));
  tx.objectStore(STORE_NAME).delete(getSnapshotKey(userId));
  const journalStore = tx.objectStore(ITEM_UPDATES_STORE);
  const journalKeys = journalStore.index('userId').getAllKeys(userId);
  journalKeys.onsuccess = () => { for (const key of journalKeys.result) journalStore.delete(key); };
  await transactionDone(tx);
  log(`📦 Folded ${folded.length} legacy item copies into per-item storage`);
  return Array.from(byId.values());
};

/** The stored library, and the server cursor it is current to (null when a full sync is needed). */
export const loadData = async (
  userId: string = 'vps',
): Promise<{ items: StoredItem[]; cursor: RevisionCursor | null }> => {
  const inMemory = () => ({ items: inMemoryStorage[userId] || [], cursor: inMemoryCursors[userId] ?? null });
  if (!(await checkIndexedDBAvailability())) {
    // The library is far larger than localStorage allows; private mode relies on the server copy.
    warn("IndexedDB not available, using in-memory storage (iOS Safari private mode?)");
    return inMemory();
  }

  let items: StoredItem[];
  let unhashed: StoredItem[];
  let cursor: RevisionCursor | null;
  try {
    const db = await getDB();
    const records = await loadItemRecords(db, userId);
    ({ unhashed, cursor } = records);
    items = await foldLegacyStores(db, records.items, userId).catch(error => {
      warn('Legacy storage fold will retry on the next launch', error);
      return records.items;
    });
  } catch (error) {
    logError("IDB Load Error", error);
    return inMemory();
  }
  persistedItems.set(userId, new Map(items.map(item => [item.data.id, item])));
  unhashedItems.set(userId, unhashed);
  return { items, cursor };
};

/** Persist a small set of changed items immediately. */
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
  await queueWrite(async () => {
    await writeItemRecords(items, userId);
    rememberPersisted(userId, items);
  });
};

/**
 * Persist the library, writing only the items replaced since they were last written. A cursor is
 * stored in the same transaction, so the stored library is never behind the cursor it claims.
 */
export const saveData = async (
  items: StoredItem[],
  userId: string = 'vps',
  cursor?: RevisionCursor,
): Promise<void> => {
  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) {
    inMemoryStorage[userId] = items;
    if (cursor) inMemoryCursors[userId] = cursor;
    return;
  }

  try {
    await queueWrite(async () => {
      const persisted = persistedItems.get(userId);
      const changed = persisted ? items.filter(item => persisted.get(item.data.id) !== item) : items;
      if (changed.length === 0 && !cursor) return;
      const db = await getDB();
      const tx = db.transaction(cursor ? [ITEM_RECORDS_STORE, STORE_NAME] : ITEM_RECORDS_STORE, 'readwrite');
      const records = tx.objectStore(ITEM_RECORDS_STORE);
      for (const item of changed) records.put(toRecord(item, userId));
      if (cursor) tx.objectStore(STORE_NAME).put(cursor, getCursorKey(userId));
      await transactionDone(tx);
      rememberPersisted(userId, changed);
    });
  } catch (error) {
    logError("IDB Save Error", error);
    inMemoryStorage[userId] = items;
  }
};

/** Removes items from local storage, such as tombstones past their retention. */
export const deleteItemRecords = async (ids: readonly string[], userId: string = 'vps'): Promise<void> => {
  if (ids.length === 0) return;
  if (!(await checkIndexedDBAvailability())) {
    const removed = new Set(ids);
    inMemoryStorage[userId] = (inMemoryStorage[userId] || []).filter(item => !removed.has(item.data.id));
    return;
  }
  await queueWrite(async () => {
    const db = await getDB();
    const tx = db.transaction(ITEM_RECORDS_STORE, 'readwrite');
    const records = tx.objectStore(ITEM_RECORDS_STORE);
    for (const id of ids) records.delete(`${userId}:${id}`);
    await transactionDone(tx);
    const persisted = persistedItems.get(userId);
    for (const id of ids) persisted?.delete(id);
  });
};

/**
 * Adds the content hash to records loaded without one, a chunk at a time between other work, so
 * later launches seed hashes instead of rehashing the whole library.
 */
export const storeMissingItemHashes = async (userId: string = 'vps'): Promise<void> => {
  const pending = unhashedItems.get(userId) ?? [];
  unhashedItems.delete(userId);
  if (pending.length === 0 || !(await checkIndexedDBAvailability())) return;
  const CHUNK = 200;
  for (let start = 0; start < pending.length; start += CHUNK) {
    await queueWrite(async () => {
      // An item replaced since launch was written with its hash already.
      const persisted = persistedItems.get(userId);
      const current = pending.slice(start, start + CHUNK).filter(item => persisted?.get(item.data.id) === item);
      await writeItemRecords(current, userId);
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

// --- Image Store (offloaded from React state to IDB) ---

const IMAGES_STORE = 'images';

// In-memory LRU cache for frequently accessed images
interface CachedImageEntry {
  url: string;
  version?: string;
}

interface StoredImageRecord {
  blob: Blob | string;
  version?: string;
}

const imageCache = new Map<string, CachedImageEntry>();
const IMAGE_CACHE_MAX = 50;

const isStoredImageRecord = (value: unknown): value is StoredImageRecord =>
  !!value && typeof value === 'object' && !(value instanceof Blob) && 'blob' in value;

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
    if (value?.url.startsWith('blob:')) URL.revokeObjectURL(value.url);
    imageCache.delete(firstKey);
  }
};

export const saveImage = async (itemId: string, base64: string, version?: string): Promise<void> => {
  const blob = dataUriToBlob(base64);
  const cachedUrl = URL.createObjectURL(blob);
  const previous = imageCache.get(itemId);
  if (previous?.url.startsWith('blob:')) URL.revokeObjectURL(previous.url);
  imageCache.set(itemId, { url: cachedUrl, version });
  evictImageCache();

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return;

  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      store.put(version ? { blob, version } satisfies StoredImageRecord : blob, itemId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to save image to IDB", e);
  }
};

export const saveImagesBatch = async (images: Array<{ id: string; base64: string; version?: string }>): Promise<void> => {
  if (images.length === 0) return;
  const encoded = images.map(image => ({ ...image, blob: dataUriToBlob(image.base64) }));

  // Populate cache
  for (const img of encoded) {
    const previous = imageCache.get(img.id);
    if (previous?.url.startsWith('blob:')) URL.revokeObjectURL(previous.url);
    imageCache.set(img.id, { url: URL.createObjectURL(img.blob), version: img.version });
  }
  // Trim cache to limit
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey) {
      const value = imageCache.get(firstKey);
      if (value?.url.startsWith('blob:')) URL.revokeObjectURL(value.url);
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
        store.put(img.version ? { blob: img.blob, version: img.version } satisfies StoredImageRecord : img.blob, img.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn("Failed to batch save images to IDB", e);
  }
};

export const loadImage = async (itemId: string, expectedVersion?: string): Promise<string | null> => {
  // Check in-memory cache first
  const cached = imageCache.get(itemId);
  if (cached && (!expectedVersion || cached.version === expectedVersion)) {
    // Move to end (most recently used)
    imageCache.delete(itemId);
    imageCache.set(itemId, cached);
    return cached.url;
  }
  if (cached) {
    if (cached.url.startsWith('blob:')) URL.revokeObjectURL(cached.url);
    imageCache.delete(itemId);
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
        const result = request.result as string | Blob | StoredImageRecord | undefined;
        const version = isStoredImageRecord(result) ? result.version : undefined;
        if (expectedVersion && version !== expectedVersion) {
          resolve(null);
          return;
        }
        const stored = isStoredImageRecord(result) ? result.blob : result;
        if (stored) {
          const url = stored instanceof Blob ? URL.createObjectURL(stored) : stored;
          imageCache.set(itemId, { url, version });
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
export const getStoredImageIds = async (
  ids: string[],
  expectedVersions?: ReadonlyMap<string, string>,
): Promise<Set<string>> => {
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
        const expectedVersion = expectedVersions?.get(id);
        if (expectedVersion) {
          const req = store.get(id);
          req.onsuccess = () => {
            const value = req.result;
            if (isStoredImageRecord(value) && value.version === expectedVersion) found.add(id);
            if (--pending === 0) resolve();
          };
          req.onerror = () => { if (--pending === 0) resolve(); };
        } else {
          // Unversioned local/user images only need an existence check.
          const req = store.getKey(id);
          req.onsuccess = () => {
            if (req.result !== undefined) found.add(id);
            if (--pending === 0) resolve();
          };
          req.onerror = () => { if (--pending === 0) resolve(); };
        }
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
          const rawValue = req.result;
          const value = isStoredImageRecord(rawValue) ? rawValue.blob : rawValue;
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
