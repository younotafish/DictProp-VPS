import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const { loadData, saveData, saveItemUpdates } = await import('../../services/storage.ts');

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

  const overlaid = await loadData(userId);
  assert.equal(overlaid.find(value => value.data.id === 'one')?.srs.totalReviews, 2);
  assert.equal(overlaid.find(value => value.data.id === 'two')?.srs.totalReviews, 1);

  await saveData(overlaid, userId);
  const savedAgain = await loadData(userId);
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

  const reviews = (items: Awaited<ReturnType<typeof loadData>>) =>
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
