import { warn } from './logger';

// The browser database that holds this device's library and its pictures: opening it, whether it works here,
// and the request helpers the stores share (services/libraryStore.ts, services/imageStore.ts).

const DB_NAME = 'PopDictDB';
const DB_VERSION = 4;

// The stores. META_STORE (v1, named 'library') once held each user's full-library snapshot, which
// foldLegacyStores empties; it also holds each user's server cursor, so it stays.
export const META_STORE = 'library';
export const IMAGES_STORE = 'images';
export const ITEM_UPDATES_STORE = 'item_updates';
export const ITEM_RECORDS_STORE = 'items_v2';

let dbPromise: Promise<IDBDatabase> | null = null;
const UPGRADE_BLOCKED = 'IndexedDB upgrade blocked by another tab';

// Whether IndexedDB works here (iOS Safari private mode once refused it). Opening the library's own
// database answers that, instead of creating and deleting a throwaway one on every launch. An upgrade
// blocked by another tab says nothing about support, and later opens retry it. Only a yes is kept: a
// failed open is tried again after a pause that doubles from a second to half a minute, so a hiccup
// doesn't cost the rest of the session its pictures and its next library load.
let indexedDBCheck: Promise<boolean> | null = null;
let indexedDBRetryAt = 0;
let indexedDBRetryDelay = 0;
const MAX_INDEXEDDB_RETRY_DELAY = 30_000;
export const checkIndexedDBAvailability = (): Promise<boolean> => {
  if (indexedDBCheck) return indexedDBCheck;
  if (Date.now() < indexedDBRetryAt) return Promise.resolve(false);
  const check: Promise<boolean> = indexedDBCheck = getDB().then(
    () => true,
    error => error instanceof Error && error.message === UPGRADE_BLOCKED,
  ).then(available => {
    if (available) {
      indexedDBRetryDelay = 0;
    } else {
      if (indexedDBCheck === check) indexedDBCheck = null;
      indexedDBRetryDelay = Math.min(indexedDBRetryDelay * 2 || 1000, MAX_INDEXEDDB_RETRY_DELAY);
      indexedDBRetryAt = Date.now() + indexedDBRetryDelay;
    }
    return available;
  });
  return check;
};

const getDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  const opening: Promise<IDBDatabase> = dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject(new Error("IndexedDB not supported"));
        return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      warn("IndexedDB open failed, will use in-memory fallback");
      reject(request.error);
    };
    request.onblocked = () => reject(new Error(UPGRADE_BLOCKED));
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => { if (dbPromise === opening) dbPromise = null; };
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // The browser closed the connection itself (storage cleared, say), so the next use opens another.
      db.onclose = forget;
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Legacy full-library snapshots (v1), emptied by foldLegacyStores, and each user's server cursor.
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      
      // Offloaded item images (v2).
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE);
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
  opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
  return opening;
};

// Safari can lose the connection while the app sits in the background, and every transaction on it fails
// from then on. Such a failure gets one more try on a new connection; the work is a single transaction,
// which either applied in full or not at all.
const LOST_CONNECTION_ERRORS = new Set(['InvalidStateError', 'UnknownError']);
export const withDB = async <T,>(work: (db: IDBDatabase) => Promise<T>): Promise<T> => {
  const db = await getDB();
  try {
    return await work(db);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !LOST_CONNECTION_ERRORS.has(name)) throw error;
    // Another caller may have replaced the connection already.
    if (dbPromise && await dbPromise.catch(() => null) === db) {
      dbPromise = null;
      db.close();
    }
    return work(await getDB());
  }
};

export const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const transactionDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});
