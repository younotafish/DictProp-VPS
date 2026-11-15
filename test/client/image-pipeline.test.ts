import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { IDBDatabase as FakeIDBDatabase, IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { MemoryStorage } from '../support/memory-storage.ts';

const storage = new MemoryStorage();
Object.assign(globalThis, { indexedDB, IDBKeyRange, localStorage: storage });

// The server for uploads keeps each upload's bytes, as the real one does when it versions them, and fails a picture
// as many times as `failures` says. In Node the optimizer hands each picture back as it came (no createImageBitmap).
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
const uploads = new Map<string, Buffer>();
const attempts = new Map<string, number>();
const failures = new Map<string, number>();
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const id = decodeURIComponent(url.split('/')[3]);
  attempts.set(id, (attempts.get(id) ?? 0) + 1);
  const failuresLeft = failures.get(id) ?? 0;
  if (failuresLeft > 0) {
    failures.set(id, failuresLeft - 1);
    return new Response('', { status: 503 });
  }
  uploads.set(id, Buffer.from(await (init.body as Blob).arrayBuffer()));
  return Response.json({ ok: true });
}) as typeof fetch;

const { offloadAndUpload, uploadPendingImages } = await import('../../services/imagePipeline.ts');
const { loadImage, peekImage, saveImagesBatch } = await import('../../services/imageStore.ts');
const { addPendingImageUploads, readPendingImageUploads } = await import('../../services/imageUploadQueue.ts');

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
/** The server's version for these bytes: server/src/db.ts takes the first 20 hex digits of their SHA-256. */
const serverVersion = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 20);

/** The images store's record for `id`, read straight from IndexedDB. */
async function storedRecord(id: string): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('PopDictDB', 4);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const record = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction('images', 'readonly').objectStore('images').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
}

/** Lets the event loop run (not timers, which some tests mock). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
}

/** Moves the mocked clock on in 100 ms steps, letting the event loop run between them, until `check` holds. */
async function advanceUntil(t: { mock: { timers: { tick(ms: number): void } } }, check: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed <= 10_000; elapsed += 100) {
    await settle();
    if (check()) return;
    t.mock.timers.tick(100);
  }
  assert.fail(`never happened: attempts ${JSON.stringify([...attempts])}`);
}

/** Runs `run` with the picture store's transactions in `mode` failing, as a full or broken IndexedDB does. */
async function withFailingImageStore(mode: IDBTransactionMode, run: () => Promise<void>): Promise<void> {
  const prototype = FakeIDBDatabase.prototype as unknown as IDBDatabase;
  const original = prototype.transaction;
  prototype.transaction = function (this: IDBDatabase, stores: string | string[], txMode?: IDBTransactionMode, ...rest: unknown[]) {
    if ([stores].flat().includes('images') && (txMode ?? 'readonly') === mode) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return (original as (...args: unknown[]) => IDBTransaction).call(this, stores, txMode, ...rest);
  } as IDBDatabase['transaction'];
  try {
    await run();
  } finally {
    prototype.transaction = original;
  }
}

test('a picture is stored under the version the server will give the bytes it uploads', async () => {
  const { stored, uploaded } = await offloadAndUpload([{ id: 'attached', base64: PNG }]);
  assert.equal(stored, true);
  assert.deepEqual(await uploaded, []);
  const version = serverVersion(uploads.get('attached')!);
  assert.equal(version, serverVersion(PNG_BYTES), 'the upload carries the stored bytes');

  // Shown at once from memory, and once the pull brings 'server:has_image:<version>', still without a download.
  const cached = peekImage('attached', version);
  assert.ok(cached);
  assert.equal(peekImage('attached'), cached, "the 'idb:stored' marker's lookup asks for no version");
  assert.equal(await loadImage('attached', version), cached);
  assert.equal(peekImage('attached', 'some-other-version'), null);

  // The device's copy carries the same version, so it is still current after a reload.
  const record = await storedRecord('attached') as { blob: Blob; version: string };
  assert.equal(record.version, version);
  assert.deepEqual(Buffer.from(await record.blob.arrayBuffer()), PNG_BYTES);
});

test('each picture is retried once on its own, and those that fail again are listed for later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  failures.set('a', 2).set('c', 1);
  const { stored, uploaded } = await offloadAndUpload(
    [{ id: 'a', base64: PNG }, { id: 'b', base64: PNG }, { id: 'c', base64: PNG }],
    'user',
  );
  assert.equal(stored, true, 'stored before any upload settles');
  await settle();
  assert.deepEqual([...attempts].filter(([id]) => 'abc'.includes(id)), [['a', 1]], 'the retry waits');
  t.mock.timers.tick(799);
  await settle();
  assert.equal(attempts.get('a'), 1);
  await advanceUntil(t, () => attempts.get('c') === 2);
  assert.deepEqual(await uploaded, ['a']);
  assert.equal(attempts.get('a'), 2);
  assert.equal(attempts.get('b'), 1, 'b went up the first time and was never sent again');
  assert.deepEqual(readPendingImageUploads('user'), ['a']);

  // Without a user id nothing is listed: the caller handles the failure.
  failures.set('d', 2);
  const unlisted = await offloadAndUpload([{ id: 'd', base64: PNG }]);
  await advanceUntil(t, () => attempts.get('d') === 2);
  assert.deepEqual(await unlisted.uploaded, ['d']);
  assert.deepEqual(readPendingImageUploads('user'), ['a']);
});

test('a picture this device could not store is reported, uploaded all the same, and never listed', async () => {
  await withFailingImageStore('readwrite', async () => {
    const { stored, uploaded } = await offloadAndUpload([{ id: 'unstored', base64: PNG }], 'other-user');
    assert.equal(stored, false);
    assert.deepEqual(await uploaded, []);
    assert.ok(uploads.has('unstored'));
    assert.ok(peekImage('unstored'), 'still shown from memory this session');
    assert.equal(await saveImagesBatch([{ id: 'unstored', image: new Blob(['x']) }]), false);
  });
  assert.equal(await saveImagesBatch([]), true, 'nothing to store is stored');
  assert.deepEqual(readPendingImageUploads('other-user'), []);
});

test('listed pictures go up later; those sent or gone from the device come off the list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 'a' is stored (the retry test listed it), 'gone' was never stored here, and 'flaky' fails again.
  await saveImagesBatch([{ id: 'flaky', image: new Blob(['f'], { type: 'image/png' }) }]);
  addPendingImageUploads('user', ['gone', 'flaky']);
  assert.deepEqual(readPendingImageUploads('user'), ['a', 'gone', 'flaky']);

  failures.set('flaky', 2);
  attempts.delete('a');
  let done = false;
  void uploadPendingImages('user').then(() => { done = true; });
  await advanceUntil(t, () => done);
  assert.equal(attempts.get('a'), 1);
  assert.equal(attempts.get('gone'), undefined);
  assert.equal(attempts.get('flaky'), 2);
  assert.deepEqual(readPendingImageUploads('user'), ['flaky']);

  // When the store can't be read, nothing is taken off: a picture missing from a failed read may still be there.
  await withFailingImageStore('readonly', () => uploadPendingImages('user'));
  assert.deepEqual(readPendingImageUploads('user'), ['flaky']);

  await uploadPendingImages('user');
  assert.deepEqual(readPendingImageUploads('user'), []);
});
