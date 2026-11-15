import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

// The server for uploads: it keeps each upload's bytes, as the real one does when it versions them. In Node the
// optimizer hands each picture back as it came (no createImageBitmap).
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
const uploads = new Map<string, Buffer>();
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const id = decodeURIComponent(url.split('/')[3]);
  uploads.set(id, Buffer.from(await (init.body as Blob).arrayBuffer()));
  return Response.json({ ok: true });
}) as typeof fetch;

const { offloadAndUpload } = await import('../../services/imagePipeline.ts');
const { loadImage, peekImage } = await import('../../services/imageStore.ts');

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

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'never happened');
}

test('a picture is stored under the version the server will give the bytes it uploads', async () => {
  await offloadAndUpload([{ id: 'attached', base64: PNG }]);
  await eventually(() => uploads.has('attached'));
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
