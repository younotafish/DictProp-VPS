import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBDatabase as FakeIDBDatabase, IDBFactory, IDBKeyRange, IDBObjectStore as FakeIDBObjectStore, forceCloseDatabase } from 'fake-indexeddb';

type AudioCache = typeof import('../../services/audioCache.ts');
interface MetaRecord { size: number; at: number }

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

// Each case gets an empty database and its own instance of the module, which keeps its connection and its
// eviction schedule in module state.
let instance = 0;
const freshCache = async (): Promise<AudioCache> => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  return await import(`../../services/audioCache.ts?instance=${++instance}`) as AudioCache;
};

const openRaw = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('DictPropAudioCache', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const keysOf = async (store: string): Promise<string[]> => {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => resolve((request.result as string[]).sort());
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};
const metaOf = async (key: string): Promise<MetaRecord | undefined> => {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('meta').objectStore('meta').get(key);
      request.onsuccess = () => resolve(request.result as MetaRecord | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};
const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));
const eventually = async (check: () => Promise<boolean>, what: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await nextTask();
  }
  assert.fail(`timed out waiting until ${what}`);
};
const clip = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' });
const timings = [{ text: 'Hello', start: 0.1, end: 0.4 }];

const setStorageEstimate = (estimate: (() => Promise<{ quota?: number; usage?: number }>) | undefined) => {
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: estimate ? { estimate } : undefined });
};
test.after(() => { Reflect.deleteProperty(globalThis.navigator, 'storage'); });

test('a stored clip and its timings come back, and a miss is null', async () => {
  const cache = await freshCache();
  await cache.putAudioBlob('k1', clip(32));
  await cache.putTimings('k1', timings);
  const stored = await cache.getAudioBlob('k1');
  assert.equal(stored?.size, 32);
  assert.deepEqual(await cache.getTimings('k1'), timings);
  assert.equal(await cache.getAudioBlob('missing'), null);
  assert.equal(await cache.getTimings('missing'), null);
});

test('empty clips and empty timings are not stored', async () => {
  const cache = await freshCache();
  assert.equal(await cache.audioCacheReady(), true);
  await cache.putAudioBlob('empty', clip(0));
  await cache.putTimings('empty', []);
  assert.deepEqual(await keysOf('audio'), []);
  assert.deepEqual(await keysOf('timings'), []);
});

test('reading a clip marks it as recently used', async () => {
  const cache = await freshCache();
  now = 2_000_000;
  await cache.putAudioBlob('k1', clip(8));
  assert.deepEqual(await metaOf('k1'), { size: 8, at: 2_000_000 });
  now = 2_500_000;
  await cache.getAudioBlob('k1');
  await eventually(async () => (await metaOf('k1'))?.at === 2_500_000, 'the hit refreshes last-used');
});

test('over budget, the least recently used clips go first, with their timings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = await freshCache();
  // 1000 bytes of quota leave room for 800 bytes of audio when nothing else is stored.
  setStorageEstimate(async () => ({ quota: 1000, usage: 0 }));
  try {
    for (const [index, key] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      now = 3_000_000 + index;
      await cache.putAudioBlob(key, clip(200));
      await cache.putTimings(key, timings);
    }
    now = 3_000_010;
    await cache.getAudioBlob('a'); // 'a' is now the most recently used
    await eventually(async () => (await metaOf('a'))?.at === 3_000_010, 'the hit on a is recorded');
    t.mock.timers.tick(3000);
    await eventually(async () => (await keysOf('audio')).length === 4, 'eviction runs');
    assert.deepEqual(await keysOf('audio'), ['a', 'c', 'd', 'e']);
    assert.deepEqual(await keysOf('meta'), ['a', 'c', 'd', 'e']);
    assert.deepEqual(await keysOf('timings'), ['a', 'c', 'd', 'e']);
  } finally {
    setStorageEstimate(undefined);
  }
});

test('a write that runs out of room frees space, oldest first, and is tried once more', async () => {
  const cache = await freshCache();
  now = 4_000_000;
  await cache.putAudioBlob('old', clip(16));
  type RawStore = { storeRecord: (...args: unknown[]) => unknown };
  const prototype = FakeIDBObjectStore.prototype as unknown as { put: (this: IDBObjectStore & { _rawObjectStore: RawStore }, ...args: unknown[]) => IDBRequest };
  const realPut = prototype.put;
  let failures = 2;
  prototype.put = function (...args) {
    if (failures > 0 && this.name === 'audio') {
      failures--;
      const raw = this._rawObjectStore;
      const store = raw.storeRecord;
      raw.storeRecord = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
      try { return realPut.apply(this, args); } finally { raw.storeRecord = store; }
    }
    return realPut.apply(this, args);
  };
  try {
    failures = 1;
    now = 4_000_100;
    await cache.putAudioBlob('new', clip(16));
    assert.deepEqual(await keysOf('audio'), ['new'], 'the old clip made room for the new one');
    failures = 2;
    await cache.putAudioBlob('skipped', clip(16));
    assert.deepEqual(await keysOf('audio'), [], 'a second failure skips caching the clip');
  } finally {
    prototype.put = realPut;
  }
});

test('a dropped connection is reopened on the next use', async () => {
  const cache = await freshCache();
  await cache.putAudioBlob('k1', clip(8));
  const prototype = FakeIDBDatabase.prototype as unknown as IDBDatabase;
  const original = prototype.transaction;
  let dropped = false;
  prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    if (!dropped) {
      dropped = true;
      forceCloseDatabase(this as never);
    }
    return original.apply(this, args);
  } as IDBDatabase['transaction'];
  try {
    assert.equal(await cache.getAudioBlob('k1'), null, 'the read on the dropped connection misses');
  } finally {
    prototype.transaction = original;
  }
  assert.equal((await cache.getAudioBlob('k1'))?.size, 8, 'the next read opens a new connection');
});

test('without IndexedDB every call is a no-op, and the cache is tried again a minute later', async () => {
  const cache = await freshCache();
  const factory = globalThis.indexedDB;
  Reflect.deleteProperty(globalThis, 'indexedDB');
  try {
    now = 5_000_000;
    assert.equal(await cache.audioCacheReady(), false);
    assert.equal(await cache.getAudioBlob('k1'), null);
    await cache.putAudioBlob('k1', clip(8));
    Object.assign(globalThis, { indexedDB: factory });
    now = 5_059_999;
    assert.equal(await cache.audioCacheReady(), false, 'still within the minute');
    now = 5_060_000;
    assert.equal(await cache.audioCacheReady(), true);
    assert.equal(await cache.getAudioBlob('k1'), null, 'the write made while unavailable was dropped');
  } finally {
    Object.assign(globalThis, { indexedDB: factory });
  }
});

test('stored keys are found without reading a clip, and a bulk mark refreshes only clips not marked within the hour', async () => {
  const cache = await freshCache();
  now = 6_000_000;
  await cache.putAudioBlob('a', clip(8));
  await cache.putAudioBlob('b', clip(8));
  await cache.putTimings('a', timings);
  assert.deepEqual([...await cache.getStoredAudioKeys(['a', 'b', 'c'])].sort(), ['a', 'b']);
  assert.deepEqual([...await cache.getStoredTimingKeys(['a', 'b', 'c'])], ['a']);
  assert.deepEqual([...await cache.getStoredAudioKeys([])], []);
  assert.equal((await metaOf('a'))?.at, 6_000_000, 'checking is not a use');
  now = 6_000_000 + 30 * 60 * 1000;
  await cache.markAudioUsed(['a', 'c']);
  assert.equal((await metaOf('a'))?.at, 6_000_000, 'marked within the hour: left alone');
  now = 6_000_000 + 60 * 60 * 1000;
  await cache.markAudioUsed(['a', 'c']);
  assert.equal((await metaOf('a'))?.at, now);
  assert.equal((await metaOf('b'))?.at, 6_000_000, 'only the given clips');
  assert.equal(await metaOf('c'), undefined, 'a clip that is not stored is not created');
});
