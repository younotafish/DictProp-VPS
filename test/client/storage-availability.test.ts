import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

// IndexedDB whose next `failuresLeft` opens fail the way Safari's do when it loses its database server.
let failuresLeft = 0;
let opens = 0;
const failedOpen = () => {
  const request = {
    error: new DOMException('Connection to Indexed Database server lost.', 'UnknownError'),
    onerror: null as (() => void) | null,
    onsuccess: null,
    onblocked: null,
    onupgradeneeded: null,
  };
  setTimeout(() => request.onerror?.(), 0);
  return request;
};
const flakyIndexedDB = {
  open: (name: string, version?: number) => {
    opens++;
    if (failuresLeft > 0) {
      failuresLeft--;
      return failedOpen();
    }
    return indexedDB.open(name, version);
  },
};
Object.assign(globalThis, { indexedDB: flakyIndexedDB, IDBKeyRange });

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

const { loadData, saveData } = await import('../../services/libraryStore.ts');
const { getAllStoredImageIds } = await import('../../services/imageStore.ts');

const item = (id: string) => ({
  type: 'vocab' as const,
  data: { id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  updatedAt: 1,
});

test('a failed open is tried again after a pause that doubles, not remembered for the session', async () => {
  failuresLeft = 3;
  assert.deepEqual(await loadData('memory-user'), { items: [], cursor: null }, 'the library loads from memory');
  assert.equal(opens, 1);

  await getAllStoredImageIds();
  now += 999;
  await getAllStoredImageIds();
  assert.equal(opens, 1, 'nothing reopens within the first second');

  now += 1;
  await getAllStoredImageIds();
  assert.equal(opens, 2, 'a second later it tries again, and fails');
  now += 1999;
  await getAllStoredImageIds();
  assert.equal(opens, 2, 'then waits two seconds');
  now += 1;
  await getAllStoredImageIds();
  assert.equal(opens, 3);

  now += 4000;
  await Promise.all([getAllStoredImageIds(), getAllStoredImageIds()]);
  assert.equal(opens, 4, 'calls made together share one attempt, which opens the database');
  now += 60_000;
  await getAllStoredImageIds();
  assert.equal(opens, 4, 'an open that worked is kept');
});

test('a library loaded from memory stays there until a load reads the stored copy', async () => {
  await saveData([item('kept-in-memory')], 'memory-user');
  assert.deepEqual((await loadData('memory-user')).items, [], 'the memory library was never written over the stored copy');

  await saveData([item('stored')], 'memory-user');
  assert.deepEqual((await loadData('memory-user')).items.map(value => value.data.id), ['stored'], 'once read, the library is stored again');
});

test('launch asks the browser to keep this origin’s storage only while it isn’t kept, and no answer or failure matters', async () => {
  const { requestPersistentStorage } = await import('../../services/idb.ts');
  const asked: string[] = [];
  const storageManager = (persisted: () => Promise<boolean>, persist: () => Promise<boolean> = async () => true) => ({
    persisted: () => { asked.push('persisted?'); return persisted(); },
    persist: () => { asked.push('persist'); return persist(); },
  });
  const install = (storage: unknown) => Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
  try {
    install(storageManager(async () => false));
    await requestPersistentStorage();
    assert.deepEqual(asked.splice(0), ['persisted?', 'persist'], 'storage not kept yet is asked for');

    install(storageManager(async () => true));
    await requestPersistentStorage();
    assert.deepEqual(asked.splice(0), ['persisted?'], 'storage already kept isn’t asked for again');

    install(storageManager(async () => false, async () => false));
    await requestPersistentStorage();
    install(storageManager(async () => false, async () => { throw new DOMException('Denied', 'NotAllowedError'); }));
    await requestPersistentStorage();
    install(storageManager(async () => { throw new Error('unavailable'); }));
    await requestPersistentStorage();
    assert.deepEqual(asked.splice(0), ['persisted?', 'persist', 'persisted?', 'persist', 'persisted?'], 'a denial or a failure is swallowed');

    install(undefined);
    await requestPersistentStorage();
    install({ persisted: () => { asked.push('persisted?'); return Promise.resolve(false); } });
    await requestPersistentStorage();
    assert.deepEqual(asked, [], 'a browser without the API is left alone');
  } finally {
    delete (navigator as { storage?: unknown }).storage;
  }
});
