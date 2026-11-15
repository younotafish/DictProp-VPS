import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

// The blob URLs the store revoked, so a test can tell an evicted picture from one still on show.
const revoked = new Set<string>();
const realRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = (url: string) => {
  revoked.add(url);
  realRevoke(url);
};
test.after(() => { URL.revokeObjectURL = realRevoke; });

const {
  getAllStoredImageIds, getStoredImageIds, loadImage, loadImagesByIds, peekImage, saveImage, saveImagesBatch,
} = await import('../../services/imageStore.ts');

const picture = (text: string) => new Blob([text], { type: 'image/png' });

/** The bytes behind a blob URL, as text. */
const shown = async (url: string | null): Promise<string | undefined> =>
  url ? resolveObjectURL(url)?.text() : undefined;

/** Waits for a background write: saveImage stores without making its caller wait. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the background write never landed');
}

/** Writes a record the way an older build did, straight into the images store. */
async function storeRaw(id: string, value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('PopDictDB', 4);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test('a picture stored with a version is shown only for that version', async () => {
  await saveImagesBatch([{ id: 'versioned', image: picture('first'), version: 'v1' }]);
  const cached = peekImage('versioned', 'v1');
  assert.equal(await shown(cached), 'first');
  assert.equal(peekImage('versioned'), cached, 'a lookup without a version takes any');
  assert.equal(peekImage('versioned', 'v2'), null);

  // Asking for another version drops the cached copy and finds no match on the device either.
  assert.equal(await loadImage('versioned', 'v2'), null);
  assert.ok(revoked.has(cached!), 'the dropped copy released its URL');
  assert.equal(peekImage('versioned'), null);

  const reloaded = await loadImage('versioned', 'v1');
  assert.equal(await shown(reloaded), 'first', 'read back from IndexedDB');
  assert.notEqual(reloaded, cached);
});

test('an unversioned picture answers any lookup, and existence checks match versions only when asked', async () => {
  const url = saveImage('plain', 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(peekImage('plain'), url, 'shown at once, before the write lands');
  await eventually(async () => (await getStoredImageIds(['plain'])).has('plain'));
  assert.equal((await getStoredImageIds(['plain'], new Map([['plain', 'v9']]))).size, 0);

  await saveImagesBatch([{ id: 'tagged', image: picture('tagged'), version: 'v3' }]);
  const versions = new Map([['tagged', 'v3']]);
  assert.deepEqual([...await getStoredImageIds(['tagged', 'missing'], versions)], ['tagged']);
  assert.equal((await getStoredImageIds(['tagged'], new Map([['tagged', 'v4']]))).size, 0);
});

test('a bulk download stores pictures without pushing others out of memory', async () => {
  await saveImagesBatch([{ id: 'bulk', image: picture('bulk') }], { remember: false });
  assert.equal(peekImage('bulk'), null);
  assert.ok((await getStoredImageIds(['bulk'])).has('bulk'));
});

test('concurrent reads of one stored picture share one read and one URL', async () => {
  await saveImagesBatch([{ id: 'shared', image: picture('shared'), version: 's1' }], { remember: false });
  const [first, second] = await Promise.all([loadImage('shared', 's1'), loadImage('shared', 's1')]);
  assert.equal(first, second);
  assert.equal(revoked.has(first!), false);
  assert.equal(await shown(first), 'shared');
});

test('a record an older build stored as a data URI is shown as it is', async () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  await storeRaw('legacy-string', dataUri);
  assert.equal(await loadImage('legacy-string'), dataUri);
  assert.equal((await loadImagesByIds(['legacy-string'])).get('legacy-string'), dataUri);
});

test('bulk queries list the stored pictures and load either record shape', async () => {
  const loaded = await loadImagesByIds(['versioned', 'bulk', 'missing']);
  assert.deepEqual([...loaded.keys()].sort(), ['bulk', 'versioned']);
  assert.equal(await (loaded.get('versioned') as Blob).text(), 'first');
  assert.equal(await (loaded.get('bulk') as Blob).text(), 'bulk');
  const all = await getAllStoredImageIds();
  for (const id of ['versioned', 'plain', 'tagged', 'bulk', 'shared', 'legacy-string']) assert.ok(all.has(id), id);
});

test('memory keeps the fifty most recent pictures and releases the URLs it evicts', async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `recent-${index}`);
  await saveImagesBatch(ids.map(id => ({ id, image: picture(id) })));
  const urls = new Map(ids.map(id => [id, peekImage(id)!]));
  assert.ok(ids.every(id => urls.get(id)), 'all fifty in memory');

  // Showing the oldest makes it the most recent, so the next one in line goes instead.
  assert.equal(peekImage('recent-0'), urls.get('recent-0'));
  await saveImagesBatch([{ id: 'recent-50', image: picture('recent-50') }]);
  assert.equal(peekImage('recent-1'), null);
  assert.ok(revoked.has(urls.get('recent-1')!));
  assert.equal(peekImage('recent-0'), urls.get('recent-0'));
  assert.equal(revoked.has(urls.get('recent-0')!), false);
});
