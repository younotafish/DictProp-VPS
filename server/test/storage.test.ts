import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const { loadData, saveData, saveItemUpdates, deleteItemRecords, storeMissingItemHashes } = await import('../../services/storage.ts');
const { getItemContentHash, ITEM_HASH_VERSION } = await import('../../services/itemHash.ts');

const item = (id: string, reviews: number) => ({
  type: 'vocab' as const,
  data: {
    id,
    word: id,
    chinese: '',
    ipa: '',
    definition: '',
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
  },
  srs: {
    id,
    type: 'vocab' as const,
    nextReview: reviews,
    interval: reviews,
    memoryStrength: reviews,
    lastReviewDate: reviews,
    totalReviews: reviews,
    correctStreak: reviews,
    stability: reviews,
  },
  savedAt: 1,
  updatedAt: reviews,
});

test('per-item records preserve immediate updates', async () => {
  const userId = 'journal-user';
  await saveData([item('one', 1), item('two', 1)], userId);
  await saveItemUpdates([item('one', 2)], userId);

  const overlaid = (await loadData(userId)).items;
  assert.equal(overlaid.find(value => value.data.id === 'one')?.srs.totalReviews, 2);
  assert.equal(overlaid.find(value => value.data.id === 'two')?.srs.totalReviews, 1);

  await saveData(overlaid, userId);
  const savedAgain = (await loadData(userId)).items;
  assert.deepEqual(savedAgain, overlaid);
});

test('unchanged full-state saves do not rewrite per-item records', async () => {
  const userId = 'record-user';
  const items = [item('stable', 1), item('changed', 1)];
  await saveData(items, userId);

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('PopDictDB', 4);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('items_v2', 'readwrite');
    const store = tx.objectStore('items_v2');
    const request = store.get(`${userId}:stable`);
    request.onsuccess = () => store.put({ ...request.result, sentinel: 'keep' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await saveData(items, userId);
  const record = await new Promise<any>((resolve, reject) => {
    const tx = db.transaction('items_v2', 'readonly');
    const request = tx.objectStore('items_v2').get(`${userId}:stable`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const journal = await new Promise<any>((resolve, reject) => {
    const tx = db.transaction('item_updates', 'readonly');
    const request = tx.objectStore('item_updates').get(`${userId}:stable`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();

  assert.equal(record.sentinel, 'keep');
  assert.equal(journal, undefined);
});

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('PopDictDB', 4);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

test('legacy snapshots and journal entries fold into the records once', async () => {
  const userId = 'legacy-user';
  await loadData(userId); // creates the v4 stores

  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['items_v2', 'library', 'item_updates'], 'readwrite');
    tx.objectStore('items_v2').put({ key: `${userId}:recorded`, userId, item: item('recorded', 2) });
    tx.objectStore('items_v2').put({ key: `${userId}:journaled`, userId, item: item('journaled', 1) });
    tx.objectStore('library').put([item('snapshot-only', 1), item('recorded', 1)], `items_${userId}`);
    tx.objectStore('item_updates').put({ key: `${userId}:journaled`, userId, item: item('journaled', 3) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const reviews = ({ items }: Awaited<ReturnType<typeof loadData>>) =>
    Object.fromEntries(items.map(value => [value.data.id, value.srs.totalReviews]));
  const expected = { 'snapshot-only': 1, recorded: 2, journaled: 3 };
  assert.deepEqual(reviews(await loadData(userId)), expected);

  const tx = db.transaction(['library', 'item_updates'], 'readonly');
  const [snapshot, journalCount] = await Promise.all([
    requestValue(tx.objectStore('library').get(`items_${userId}`)),
    requestValue(tx.objectStore('item_updates').index('userId').count(userId)),
  ]);
  db.close();
  assert.equal(snapshot, undefined);
  assert.equal(journalCount, 0);
  assert.deepEqual(reviews(await loadData(userId)), expected);
});

const readRecord = async (key: string) => {
  const db = await openDatabase();
  const record = await requestValue(db.transaction('items_v2', 'readonly').objectStore('items_v2').get(key));
  db.close();
  return record;
};

test('the server cursor is stored with the items it covers', async () => {
  const userId = 'cursor-user';
  assert.equal((await loadData(userId)).cursor, null);
  const items = [item('first', 1)];
  await saveData(items, userId, { revision: 5, id: 'first' });
  assert.deepEqual(await loadData(userId), { items, cursor: { revision: 5, id: 'first' } });

  // A pull that changed no item still advances the stored cursor.
  const { items: loaded } = await loadData(userId);
  await saveData(loaded, userId, { revision: 8, id: 'other' });
  assert.deepEqual((await loadData(userId)).cursor, { revision: 8, id: 'other' });
});

test('records carry their content hash, which launch reuses', async () => {
  const userId = 'hash-user';
  const saved = item('hashed', 1);
  await saveData([saved], userId);
  const record = await readRecord(`${userId}:hashed`);
  assert.equal(record.hash, getItemContentHash(saved));
  assert.equal(record.hashVersion, ITEM_HASH_VERSION);

  // The stored hash is taken on trust, so a planted value shows it was seeded rather than computed.
  const db = await openDatabase();
  await requestValue(db.transaction('items_v2', 'readwrite').objectStore('items_v2').put({ ...record, hash: 'planted' }));
  db.close();
  const [loaded] = (await loadData(userId)).items;
  assert.equal(getItemContentHash(loaded), 'planted');
});

test('records written without a hash gain one after launch', async () => {
  const userId = 'unhashed-user';
  await loadData(userId);
  const db = await openDatabase();
  await requestValue(db.transaction('items_v2', 'readwrite').objectStore('items_v2')
    .put({ key: `${userId}:old`, userId, item: item('old', 1) }));
  db.close();

  const [loaded] = (await loadData(userId)).items;
  await storeMissingItemHashes(userId);
  const record = await readRecord(`${userId}:old`);
  assert.equal(record.hash, getItemContentHash(loaded));
  assert.equal(record.hashVersion, ITEM_HASH_VERSION);
});

test('deleted records are gone from storage and written again if the item returns', async () => {
  const userId = 'delete-user';
  const kept = item('kept', 1);
  const dropped = item('dropped', 1);
  await saveData([kept, dropped], userId);
  await deleteItemRecords(['dropped'], userId);
  assert.deepEqual((await loadData(userId)).items.map(value => value.data.id), ['kept']);

  await saveData([kept, dropped], userId);
  assert.deepEqual((await loadData(userId)).items.map(value => value.data.id).sort(), ['dropped', 'kept']);
});
