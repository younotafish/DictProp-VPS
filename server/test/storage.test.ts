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

test('per-item records and the compatibility journal preserve immediate updates', async () => {
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
  assert.equal(journal.item.data.id, 'stable');
});
