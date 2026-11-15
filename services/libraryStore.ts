import type { RevisionCursor, StoredItem } from '../types';
import { checkIndexedDBAvailability, ITEM_RECORDS_STORE, ITEM_UPDATES_STORE, META_STORE, requestResult, transactionDone, withDB } from './idb';
import { getItemContentHash, ITEM_HASH_VERSION, seedItemContentHash } from './itemHash';
import { log, logError, warn } from './logger';
import { isSameJson } from './sameJson';

// This device's copy of the library: one record per item, the server cursor it is current to, one write at a
// time, and an in-memory library where IndexedDB doesn't work.

// Builds before per-item records stored each user's library as one array under this key.
const getSnapshotKey = (userId: string) => `items_${userId}`;
// The server revision cursor the stored library is current to, kept beside the snapshot key.
const getCursorKey = (userId: string) => `cursor_${userId}`;

// Fallback storage for iOS Safari private mode
const inMemoryStorage: Record<string, StoredItem[]> = {};
const inMemoryCursors: Record<string, RevisionCursor> = {};

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

const isValidItem = (value: unknown): value is StoredItem => {
  const item = value as { data?: { id?: unknown }; type?: unknown } | null | undefined;
  return !!item?.data?.id && !!item.type;
};

const isRevisionCursor = (value: unknown): value is RevisionCursor => {
  const cursor = value as { revision?: unknown; id?: unknown } | null | undefined;
  return typeof cursor?.revision === 'number' && Number.isSafeInteger(cursor.revision) && cursor.revision >= 0 &&
    typeof cursor.id === 'string';
};

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

// Users whose library this session came from memory, because IndexedDB wouldn't open when it loaded.
// Their stored copy wasn't read, so writing this session's library over it could replace changes it
// holds that haven't synced: their library stays in memory until a later load reads the stored copy.
const memoryLibraries = new Set<string>();
const usesIndexedDB = async (userId: string): Promise<boolean> =>
  !memoryLibraries.has(userId) && await checkIndexedDBAvailability();

const loadItemRecords = async (
  db: IDBDatabase,
  userId: string,
): Promise<{ items: StoredItem[]; unhashed: StoredItem[]; cursor: RevisionCursor | null }> => {
  const tx = db.transaction([ITEM_RECORDS_STORE, META_STORE], 'readonly');
  const [records, cursor] = await Promise.all([
    requestResult(tx.objectStore(ITEM_RECORDS_STORE).index('userId').getAll(userId)),
    requestResult(tx.objectStore(META_STORE).get(getCursorKey(userId))),
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
  await withDB(db => {
    const tx = db.transaction(ITEM_RECORDS_STORE, 'readwrite');
    const records = tx.objectStore(ITEM_RECORDS_STORE);
    for (const item of items) records.put(toRecord(item, userId));
    return transactionDone(tx);
  });
};

/**
 * Older builds kept a full-library snapshot and then a per-item journal beside the records. Fold
 * whatever they still hold into the records once and clear them, so launch reads the library once
 * instead of up to three times. Counting is cheap; the legacy values are read only when present.
 */
const foldLegacyStores = async (db: IDBDatabase, records: StoredItem[], userId: string): Promise<StoredItem[]> => {
  const countTx = db.transaction([META_STORE, ITEM_UPDATES_STORE], 'readonly');
  const [snapshotCount, journalCount] = await Promise.all([
    requestResult(countTx.objectStore(META_STORE).count(getSnapshotKey(userId))),
    requestResult(countTx.objectStore(ITEM_UPDATES_STORE).index('userId').count(userId)),
  ]);
  if (snapshotCount === 0 && journalCount === 0) return records;

  const readTx = db.transaction([META_STORE, ITEM_UPDATES_STORE], 'readonly');
  const [snapshot, journal] = await Promise.all([
    requestResult(readTx.objectStore(META_STORE).get(getSnapshotKey(userId))),
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
  const tx = db.transaction([ITEM_RECORDS_STORE, META_STORE, ITEM_UPDATES_STORE], 'readwrite');
  const recordStore = tx.objectStore(ITEM_RECORDS_STORE);
  for (const item of folded) recordStore.put(toRecord(item, userId));
  tx.objectStore(META_STORE).delete(getSnapshotKey(userId));
  const journalStore = tx.objectStore(ITEM_UPDATES_STORE);
  const journalKeys = journalStore.index('userId').getAllKeys(userId);
  journalKeys.onsuccess = () => { for (const key of journalKeys.result) journalStore.delete(key); };
  await transactionDone(tx);
  log(`📦 Folded ${folded.length} legacy item copies into per-item storage`);
  return Array.from(byId.values());
};

/**
 * This device's library exists but couldn't be read. Carrying on with an empty library would let the
 * server's copy overwrite changes that haven't synced, so the caller retries instead.
 */
class LocalLibraryReadError extends Error {
  constructor(cause: unknown) {
    super('This device\u2019s library could not be read.', { cause });
    this.name = 'LocalLibraryReadError';
  }
}

/** The stored library, and the server cursor it is current to (null when a full sync is needed). */
export const loadData = async (
  userId: string,
): Promise<{ items: StoredItem[]; cursor: RevisionCursor | null }> => {
  const inMemory = () => ({ items: inMemoryStorage[userId] || [], cursor: inMemoryCursors[userId] ?? null });
  if (!(await checkIndexedDBAvailability())) {
    // The library is far larger than localStorage allows; private mode relies on the server copy.
    warn("IndexedDB not available, using in-memory storage (iOS Safari private mode?)");
    memoryLibraries.add(userId);
    return inMemory();
  }

  let items: StoredItem[];
  let unhashed: StoredItem[];
  let cursor: RevisionCursor | null;
  try {
    const records = await withDB(db => loadItemRecords(db, userId));
    ({ unhashed, cursor } = records);
    items = await withDB(db => foldLegacyStores(db, records.items, userId)).catch(error => {
      warn('Legacy storage fold will retry on the next launch', error);
      return records.items;
    });
  } catch (error) {
    logError("IDB Load Error", error);
    throw new LocalLibraryReadError(error);
  }
  persistedItems.set(userId, new Map(items.map(item => [item.data.id, item])));
  unhashedItems.set(userId, unhashed);
  memoryLibraries.delete(userId);
  return { items, cursor };
};

// Whether the last full save failed, and who wants to know when that changes.
let libraryWriteFailed = false;
const writeFailureListeners = new Set<(failed: boolean) => void>();
const setLibraryWriteFailed = (failed: boolean): void => {
  if (failed === libraryWriteFailed) return;
  libraryWriteFailed = failed;
  for (const listener of writeFailureListeners) listener(failed);
};

/**
 * Calls `listener` now and whenever saving the library on this device starts or stops failing (storage
 * full, say). A failed save leaves its items to the next one, which clears the failure once they're in.
 */
export const subscribeLibraryWriteFailures = (listener: (failed: boolean) => void): (() => void) => {
  writeFailureListeners.add(listener);
  listener(libraryWriteFailed);
  return () => { writeFailureListeners.delete(listener); };
};

/** Persist a small set of changed items immediately. */
export const saveItemUpdates = async (
  items: StoredItem[],
  userId: string,
): Promise<void> => {
  if (items.length === 0) return;
  if (!(await usesIndexedDB(userId))) {
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
  userId: string,
  cursor?: RevisionCursor,
): Promise<void> => {
  if (!(await usesIndexedDB(userId))) {
    inMemoryStorage[userId] = items;
    if (cursor) inMemoryCursors[userId] = cursor;
    return;
  }

  try {
    await queueWrite(async () => {
      const persisted = persistedItems.get(userId);
      const changed = persisted ? items.filter(item => persisted.get(item.data.id) !== item) : items;
      if (changed.length === 0 && !cursor) return;
      await withDB(db => {
        const tx = db.transaction(cursor ? [ITEM_RECORDS_STORE, META_STORE] : ITEM_RECORDS_STORE, 'readwrite');
        const records = tx.objectStore(ITEM_RECORDS_STORE);
        for (const item of changed) records.put(toRecord(item, userId));
        if (cursor) tx.objectStore(META_STORE).put(cursor, getCursorKey(userId));
        return transactionDone(tx);
      });
      rememberPersisted(userId, changed);
    });
    // The whole library is stored now, including items an earlier failed save left out.
    setLibraryWriteFailed(false);
  } catch (error) {
    logError("IDB Save Error", error);
    setLibraryWriteFailed(true);
  }
};

/** Removes items from local storage, such as tombstones past their retention. */
export const deleteItemRecords = async (ids: readonly string[], userId: string): Promise<void> => {
  if (ids.length === 0) return;
  if (!(await usesIndexedDB(userId))) {
    const removed = new Set(ids);
    inMemoryStorage[userId] = (inMemoryStorage[userId] || []).filter(item => !removed.has(item.data.id));
    return;
  }
  await queueWrite(async () => {
    await withDB(db => {
      const tx = db.transaction(ITEM_RECORDS_STORE, 'readwrite');
      const records = tx.objectStore(ITEM_RECORDS_STORE);
      for (const id of ids) records.delete(`${userId}:${id}`);
      return transactionDone(tx);
    });
    const persisted = persistedItems.get(userId);
    for (const id of ids) persisted?.delete(id);
  });
};

/**
 * Adds the content hash to records loaded without one, a chunk at a time between other work, so
 * later launches seed hashes instead of rehashing the whole library.
 */
export const storeMissingItemHashes = async (userId: string): Promise<void> => {
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
