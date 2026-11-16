import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { IDBDatabase as FakeIDBDatabase, IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type { SearchResult, StoredItem, VocabCard } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

Object.assign(globalThis, { indexedDB, IDBKeyRange, localStorage: new MemoryStorage() });

// The server, as far as pictures go: downloads answer per id, and uploads succeed unless their id is in
// `failingUploads`. In Node createImageBitmap is missing, so the optimizer hands each picture back as it came.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
const downloads: Record<string, () => Response | Promise<Response>> = {};
const failingUploads = new Set<string>();
const requests: string[] = [];
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? 'GET';
  requests.push(`${method} ${url}`);
  const id = decodeURIComponent(url.split('/')[3]);
  if (method === 'PUT') return failingUploads.has(id) ? new Response('', { status: 503 }) : Response.json({ ok: true });
  return downloads[id]?.() ?? new Response('', { status: 404 });
}) as typeof fetch;

const {
  IMAGE_IDB_MARKER, attachImage, createImageUploadRetry, extractInlineImages, getServerImageVersion, isImageMarker,
  isLazyImageMarker, lazyLoadImage, picturesOf, restoreInlineImages, retryPendingImageUploads, stripAndStoreImages,
  unsavedImages,
} = await import('../../services/libraryImages.ts');
const { getStoredImageIds, loadImage, peekImage, saveImagesBatch } = await import('../../services/imageStore.ts');
const { addPendingImageUploads, readPendingImageUploads } = await import('../../services/imageUploadQueue.ts');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const MARKER = 'server:has_image:aaaaaaaaaaaaaaaaaaaa';

const card = (id: string, imageUrl?: string): VocabCard => ({
  id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
  history: '', register: '', mnemonic: '', imageUrl,
});
const schedule = (id: string, type: StoredItem['type']) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
});
const vocabItem = (id: string, imageUrl?: string): StoredItem => ({ type: 'vocab', data: card(id, imageUrl), savedAt: 1, srs: schedule(id, 'vocab') });
const phraseItem = (id: string, imageUrl: string | undefined, vocabs: VocabCard[]): StoredItem => ({
  type: 'phrase',
  data: { id, query: id, translation: '', grammar: '', visualKeyword: '', pronunciation: '', timestamp: 1, vocabs, imageUrl },
  savedAt: 1,
  srs: schedule(id, 'phrase'),
});
const sentenceItem = (id: string, imageUrl?: string): StoredItem => ({
  type: 'sentence', data: { id, text: 'A sentence.', sourceWord: 'word', imageUrl }, savedAt: 1, srs: schedule(id, 'sentence'),
});

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('never happened');
}

/** Moves the mocked clock on in 100 ms steps, letting the event loop (not timers) run between them, until `check` holds. */
async function advanceUntil(t: TestContext, check: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed <= 10_000; elapsed += 100) {
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    if (check()) return;
    t.mock.timers.tick(100);
  }
  assert.fail('never happened');
}

/** Runs `run` with writes to the picture store failing, as a full or broken IndexedDB does. */
async function withFailingImageWrites(run: () => Promise<void>): Promise<void> {
  const prototype = FakeIDBDatabase.prototype as unknown as IDBDatabase;
  const original = prototype.transaction;
  prototype.transaction = function (this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, ...rest: unknown[]) {
    if ([stores].flat().includes('images') && mode === 'readwrite') throw new DOMException('Full', 'QuotaExceededError');
    return (original as (...args: unknown[]) => IDBTransaction).call(this, stores, mode, ...rest);
  } as IDBDatabase['transaction'];
  try {
    await run();
  } finally {
    prototype.transaction = original;
  }
}

test('markers: a versioned server marker names its version, and idb:stored and versioned markers load by id', () => {
  assert.equal(getServerImageVersion(MARKER), 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(getServerImageVersion('server:has_image'), undefined);
  assert.equal(getServerImageVersion(IMAGE_IDB_MARKER), undefined);
  assert.equal(getServerImageVersion(undefined), undefined);

  for (const marker of [MARKER, 'server:has_image', IMAGE_IDB_MARKER]) assert.equal(isImageMarker(marker), true, marker);
  for (const other of [PNG, '/api/sentence-enrichments/x/image', '', undefined]) assert.equal(isImageMarker(other), false, String(other));

  assert.equal(isLazyImageMarker(IMAGE_IDB_MARKER), true);
  assert.equal(isLazyImageMarker(MARKER), true);
  assert.equal(isLazyImageMarker('server:has_image'), false, 'the bare marker names nothing to load');
  assert.equal(isLazyImageMarker(PNG), false);
  assert.equal(isLazyImageMarker(undefined), false);
});

test('a card lists its own picture and, for a phrase, its words\' pictures', () => {
  assert.deepEqual(picturesOf(vocabItem('v', MARKER)), [{ id: 'v', imageUrl: MARKER }]);
  assert.deepEqual(picturesOf(phraseItem('p', undefined, [card('a', IMAGE_IDB_MARKER), card('b')])), [
    { id: 'p', imageUrl: undefined }, { id: 'a', imageUrl: IMAGE_IDB_MARKER }, { id: 'b', imageUrl: undefined },
  ]);
  assert.deepEqual(picturesOf(sentenceItem('s', '/api/x')), [{ id: 's', imageUrl: '/api/x' }]);
});

test('inline pictures are swapped for markers under the ids they are stored by, and a sentence keeps its own', () => {
  const vocab = vocabItem('v', PNG);
  const extracted = extractInlineImages(vocab);
  assert.deepEqual(extracted.images, [{ id: 'v', base64: PNG }]);
  assert.equal((extracted.item.data as VocabCard).imageUrl, IMAGE_IDB_MARKER);
  assert.equal(vocab.data.imageUrl, PNG, 'the input is left as it was');

  const phrase = phraseItem('p', PNG, [card('a', PNG), card('b', MARKER)]);
  const fromPhrase = extractInlineImages(phrase, 'saved-id');
  assert.deepEqual(fromPhrase.images, [{ id: 'saved-id', base64: PNG }, { id: 'a', base64: PNG }]);
  const data = fromPhrase.item.data as SearchResult;
  assert.equal(data.imageUrl, IMAGE_IDB_MARKER);
  assert.deepEqual(data.vocabs.map(v => v.imageUrl), [IMAGE_IDB_MARKER, MARKER]);
  assert.equal(data.vocabs[1], (phrase.data as SearchResult).vocabs[1], 'an untouched word keeps its object');

  for (const unchanged of [sentenceItem('s', PNG), vocabItem('w', MARKER), phraseItem('q', undefined, [card('c')])]) {
    const result = extractInlineImages(unchanged);
    assert.equal(result.item, unchanged);
    assert.deepEqual(result.images, []);
  }
});

test('launch stores inline pictures on the device, uploads them, and leaves other items as they were', async () => {
  const plain = vocabItem('plain', MARKER);
  const items = [vocabItem('launch-v', PNG), plain, phraseItem('launch-p', undefined, [card('launch-a', PNG)])];
  const stripped = await stripAndStoreImages(items, 'user');
  assert.equal(stripped[1], plain);
  assert.equal((stripped[0].data as VocabCard).imageUrl, IMAGE_IDB_MARKER);
  assert.equal((stripped[2].data as SearchResult).vocabs[0].imageUrl, IMAGE_IDB_MARKER);
  assert.deepEqual([...await getStoredImageIds(['launch-v', 'launch-a', 'plain'])].sort(), ['launch-a', 'launch-v']);
  await eventually(() => ['launch-v', 'launch-a'].every(id => requests.includes(`PUT /api/items/${id}/image`)));

  const untouched = [plain];
  assert.deepEqual(await stripAndStoreImages(untouched, 'user'), untouched);
});

test('a picture missing on the device downloads once however many views ask for it', async () => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  downloads.shared = async () => {
    await released;
    return new Response(new Blob(['picture'], { type: 'image/webp' }));
  };
  const before = requests.length;
  const first = lazyLoadImage('shared', 'v1');
  const second = lazyLoadImage('shared', 'v1');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.ok(a, 'resolves to the URL to show');
  assert.equal(peekImage('shared', 'v1'), a, 'and caches it under its version');
  assert.equal(requests.length - before, 1);

  await lazyLoadImage('shared', 'v2');
  assert.equal(requests.length - before, 2, 'another version is another download');
});

test('a failed download can be retried, and a picture the server lacks resolves to nothing', async () => {
  downloads.flaky = () => new Response('', { status: 500 });
  await assert.rejects(lazyLoadImage('flaky'), /Failed to load image: 500/);
  downloads.flaky = () => new Response(new Blob(['ok'], { type: 'image/png' }));
  assert.ok(await lazyLoadImage('flaky'), 'the next call downloads again');

  assert.equal(await lazyLoadImage('nowhere', 'v1'), null);
  assert.equal(peekImage('nowhere'), null);
});

test('a failed offload puts back only the pictures it was given, on cards still marked as stored here', () => {
  const images = new Map([['v', PNG], ['a', PNG]]);
  const restored = restoreInlineImages(vocabItem('v', IMAGE_IDB_MARKER), images);
  assert.equal((restored.data as VocabCard).imageUrl, PNG);

  for (const unchanged of [vocabItem('other', IMAGE_IDB_MARKER), vocabItem('v', MARKER), vocabItem('v')]) {
    assert.equal(restoreInlineImages(unchanged, images), unchanged);
  }

  const phrase = phraseItem('p', IMAGE_IDB_MARKER, [card('a', IMAGE_IDB_MARKER), card('b', IMAGE_IDB_MARKER)]);
  const restoredPhrase = restoreInlineImages(phrase, images).data as SearchResult;
  assert.equal(restoredPhrase.imageUrl, IMAGE_IDB_MARKER, 'the phrase\'s own picture was not in the failed offload');
  assert.deepEqual(restoredPhrase.vocabs.map(v => v.imageUrl), [PNG, IMAGE_IDB_MARKER]);

  // Nothing to restore keeps the item, so replacing it changes nothing in the library.
  const nothingToRestore = phraseItem('q', IMAGE_IDB_MARKER, [card('c', IMAGE_IDB_MARKER)]);
  assert.equal(restoreInlineImages(nothingToRestore, images), nothingToRestore);
});

test('launch keeps the pictures inline when this device cannot store them, so no marker points at nothing', async () => {
  await withFailingImageWrites(async () => {
    await assert.rejects(stripAndStoreImages([vocabItem('unstorable', PNG)], 'user'), /could not be stored on this device/);
  });
  assert.deepEqual(readPendingImageUploads('user'), [], 'a picture not stored here is never listed for a retry');
});

test('the pictures an offload saved nowhere are those this device could not store whose upload failed as well', async () => {
  const images = [{ id: 'a', base64: PNG }, { id: 'b', base64: PNG }];
  const neverUploaded = new Promise<string[]>(() => {});
  assert.deepEqual(await unsavedImages(images, { stored: true, uploaded: neverUploaded }), [], 'stored ones never wait on their upload');
  assert.deepEqual(await unsavedImages(images, { stored: false, uploaded: Promise.resolve(['b']) }), [images[1]]);
  assert.deepEqual(await unsavedImages(images, { stored: false, uploaded: Promise.resolve([]) }), [], 'uploaded ones load from the server');
});

test('an attached picture is in place once stored here, or else once uploaded; one saved nowhere is refused and forgotten', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Stored here, the card can show it at once; its failed upload is listed under the account for a retry.
  failingUploads.add('attach-stored');
  await attachImage('attach-stored', PNG, 'attacher');
  assert.ok(peekImage('attach-stored'));
  await advanceUntil(t, () => readPendingImageUploads('attacher').includes('attach-stored'));

  // The card had a picture of its own, stored on this device.
  await saveImagesBatch([{ id: 'attach-nowhere', image: new Blob(['old'], { type: 'image/png' }) }]);
  failingUploads.add('attach-nowhere');
  let refusal: unknown;
  await withFailingImageWrites(async () => {
    await attachImage('attach-uploaded', PNG, 'attacher');
    void attachImage('attach-nowhere', PNG, 'attacher').catch(error => { refusal = error; });
    await advanceUntil(t, () => refusal !== undefined);
  });
  assert.match(String(refusal), /could not be saved/);
  assert.equal(peekImage('attach-nowhere'), null, 'the refused picture is not left in memory');
  assert.ok(await loadImage('attach-nowhere'), 'so the card shows the one it had, read from the device');
  assert.deepEqual(readPendingImageUploads('attacher'), ['attach-stored'], 'pictures not stored here are never listed');
});

test('listed uploads are retried one run at a time, and nothing loads when nothing waits', async () => {
  assert.equal(await retryPendingImageUploads('nobody'), undefined);

  addPendingImageUploads('user', ['launch-v']);
  const before = requests.filter(request => request === 'PUT /api/items/launch-v/image').length;
  const run = retryPendingImageUploads('user');
  assert.equal(retryPendingImageUploads('user'), run, 'a second call joins the run under way');
  await run;
  assert.equal(requests.filter(request => request === 'PUT /api/items/launch-v/image').length, before + 1);
  assert.deepEqual(readPendingImageUploads('user'), []);
});

test("each account's listed uploads run on their own: a call never joins another account's run", async () => {
  await saveImagesBatch([
    { id: 'mine', image: new Blob(['m'], { type: 'image/png' }) },
    { id: 'theirs', image: new Blob(['t'], { type: 'image/png' }) },
  ]);
  addPendingImageUploads('me', ['mine']);
  addPendingImageUploads('them', ['theirs']);
  const mine = retryPendingImageUploads('me');
  const theirs = retryPendingImageUploads('them');
  assert.notEqual(theirs, mine);
  await Promise.all([mine, theirs]);
  assert.deepEqual([readPendingImageUploads('me'), readPendingImageUploads('them')], [[], []]);
  assert.ok(requests.includes('PUT /api/items/mine/image') && requests.includes('PUT /api/items/theirs/image'));
});

test('listed uploads go up after the first sync that gets through, and again once the connection comes back or a sync fails', () => {
  const retried: string[] = [];
  const retry = createImageUploadRetry('user', async userId => { retried.push(userId); });
  retry.synced();
  assert.deepEqual(retried, ['user'], 'opening the app makes a retry due');
  retry.synced();
  assert.deepEqual(retried, ['user'], 'not every sync retries');
  retry.retryAfterNextSync();
  retry.retryAfterNextSync();
  assert.deepEqual(retried, ['user'], 'nothing goes up before a sync gets through');
  retry.synced();
  retry.synced();
  assert.deepEqual(retried, ['user', 'user']);
});
