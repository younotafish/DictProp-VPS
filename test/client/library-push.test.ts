import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useLibrary, type Library } from '../../hooks/useLibrary.ts';
import { getItemContentHash } from '../../services/itemHash.ts';
import { enqueuePendingReviewMutation, removePendingReviewMutation } from '../../services/reviewQueue.ts';
import { NO_TROUBLE } from '../../services/syncRetry.ts';
import type { ReviewEvent, StoredItem } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// hooks/useLibrary.ts's pushes, mounted in a component that draws nothing and run against a fake server: what a push
// that sends nothing does to the retries, and the count of items the server refused. The review outbox reads
// localStorage, and the library is stored in memory, as on a browser without IndexedDB.

const USER = 'u1';
const card = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition: `definition of ${id}`, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
/** A copy the server has acknowledged. */
const synced = (item: StoredItem): StoredItem => ({ ...item, lastSyncedHash: getItemContentHash(item) });
const review = (id: string, itemId: string): ReviewEvent => ({ id, itemId, itemType: 'vocab', reviewedAt: 1, previousStep: 0, nextStep: 1 });

const down = (): Response => new Response('Service unavailable', { status: 503 });
/** How the fake server answers a push: by default it's down. */
let answerPush = down;

// Just enough of a browser for React to mount the hook, as in connectivity-notice.test.ts, with the server behind fetch.
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;
before(() => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true, localStorage: new MemoryStorage() });
  globalThis.fetch = async () => answerPush();
});
after(() => {
  globalThis.fetch = realFetch;
  for (const name of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage']) delete globals[name];
});

/** useLibrary mounted for USER; `now` is what its last render returned, and `run` acts on it as it is then. */
async function mountLibrary() {
  const seen: Library[] = [];
  const Probe = () => {
    seen.push(useLibrary(USER));
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  const now = () => seen[seen.length - 1];
  return {
    now,
    run: (work: (library: Library) => unknown) => act(async () => { await work(now()); }),
    /** A full push, as the debounced save and the retries make; a failed one counts as sending nothing. */
    push: async (): Promise<number> => {
      let sent = 0;
      await act(async () => { sent = await now().pushNow().catch(() => 0); });
      return sent;
    },
    close: () => act(() => root.unmount()),
  };
}

test('a push that finds only changes waiting on a queued review or an undo keeps the retries going; nothing unsent ends them', async () => {
  const library = await mountLibrary();
  try {
    await library.run(({ adoptStoredLibrary }) => adoptStoredLibrary([card('x')], null));
    await library.push();
    await library.push();
    const failing = library.now().pushTrouble;
    assert.equal(failing.failures, 2, 'the server is down');

    // x is graded meanwhile: pushes leave it to the review outbox, but its edit and the review haven't reached the server.
    enqueuePendingReviewMutation(USER, { event: review('r1', 'x'), itemIds: ['x'], optimisticSrs: {} });
    assert.equal(await library.push(), 0);
    assert.deepEqual(library.now().pushTrouble, failing, 'still stuck: the stuck-sync pill and the retries stay');

    // Likewise while x is held for an undo.
    removePendingReviewMutation(USER, 'r1');
    await library.run(({ holdFromPush }) => holdFromPush(['x']));
    assert.equal(await library.push(), 0);
    assert.deepEqual(library.now().pushTrouble, failing);
    await library.run(({ holdFromPush }) => holdFromPush(null));

    // A pull brings x back as the server has it, saved by a push whose answer was lost: nothing is left to send.
    await library.run(({ adoptStoredLibrary }) => adoptStoredLibrary([synced(card('x'))], null));
    assert.equal(await library.push(), 0);
    assert.deepEqual(library.now().pushTrouble, NO_TROUBLE);
  } finally {
    await library.close();
  }
});

test('an item the server refuses counts as staying on this device until it changes, and then goes to the server again', async () => {
  const library = await mountLibrary();
  const edit = (item: StoredItem): StoredItem => ({ ...item, data: { ...item.data, definition: 'shorter' } as StoredItem['data'] });
  try {
    await library.run(({ adoptStoredLibrary }) => adoptStoredLibrary([card('big'), synced(card('fine'))], null));
    assert.equal(library.now().refusedChanges, 0);
    answerPush = () => new Response(JSON.stringify({ error: 'Item too large' }), { status: 400 });
    assert.equal(await library.push(), 1);
    assert.equal(library.now().refusedChanges, 1);
    assert.deepEqual(library.now().pushTrouble, NO_TROUBLE, 'a refusal is an answer, not a failure');

    // The same content would be refused again, so the next push leaves it on this device, still counted.
    assert.equal(await library.push(), 0);
    assert.equal(library.now().refusedChanges, 1);

    // Edited, it's a change to send again, no longer refused, whether or not that push gets through.
    answerPush = down;
    await library.run(({ replaceItem }) => replaceItem('big', edit));
    await library.push();
    assert.equal(library.now().refusedChanges, 0);
    assert.equal(library.now().pushTrouble.failures, 1, 'it was sent');
  } finally {
    answerPush = down;
    await library.close();
  }
});
