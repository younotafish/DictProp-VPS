import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ItemGroup, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import {
  automaticWrite, cardIds, goneFromLibrary, liveIdsAmong, ownSentenceIds, useLeaveGoneItems, type LiveIds,
} from '../../views/detail/goneItems.ts';

// An item deleted on another device, as the open card view meets it (views/detail/goneItems.ts): it leaves the view,
// once App can take it out, and the writes the view makes on its own never bring it back.

test('a write the view makes on its own patches a live record, creates a catalog line\'s first record, and skips the rest', () => {
  assert.equal(automaticWrite({ live: true, catalogLine: false }), 'patch', 'a saved sentence');
  assert.equal(automaticWrite({ live: true, catalogLine: true }), 'patch', 'a catalog line with its record');
  assert.equal(automaticWrite({ live: false, catalogLine: true }), 'create', 'a catalog line\'s first listen');
  assert.equal(automaticWrite({ live: false, catalogLine: false }), 'skip', 'deleted on another device, or an unsaved example');
});

test('an item is gone when the library held it and no longer does; one it never held is never gone', () => {
  const wasLive = new Set(['kept', 'deleted elsewhere']);
  const liveNow = new Set(['kept', 'saved just now']);
  assert.deepEqual(goneFromLibrary(['kept', 'deleted elsewhere', 'unsaved card', 'saved just now'], wasLive, liveNow), ['deleted elsewhere']);
  assert.deepEqual(goneFromLibrary([], wasLive, liveNow), []);
  // The sentence view checks against its index of saved sentences, a Map by id.
  const byId = new Map([['kept', {}]]);
  assert.deepEqual(goneFromLibrary(['kept', 'deleted elsewhere'], wasLive, byId), ['deleted elsewhere']);
});

const word = (id: string, spelling = id): StoredItem => ({
  type: 'vocab',
  data: { id, word: spelling, examples: [] } as Partial<VocabCard> as VocabCard,
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});
const sentence = (id: string, catalogSentenceId?: string): StoredItem => ({
  type: 'sentence',
  data: { id, text: `Line ${id}.`, sourceWord: 'line', ...(catalogSentenceId ? { catalogSentenceId } : {}) },
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'sentence', 0),
});

test('the word view checks its cards, every meaning of every word, against the library\'s live copies only', () => {
  const groups: ItemGroup[] = [
    { title: 'bank', items: [word('bank:river', 'bank'), word('bank:money', 'bank')] },
    { title: 'apple', items: [word('apple')] },
  ];
  assert.deepEqual(cardIds(groups), ['bank:river', 'bank:money', 'apple']);
  const library = [word('apple'), { ...word('bank:money', 'bank'), isDeleted: true }, word('elsewhere')];
  assert.deepEqual([...liveIdsAmong(cardIds(groups), library)], ['apple'], 'a tombstone and a card outside the view don\'t count');
});

test('a run\'s own saved sentences can leave it; a Real Life or essay line stays, with or without its record', () => {
  const run = [
    sentence('own'),
    sentence('real-life-sentence:rl-1', 'rl-1'),
    sentence('catalog-preview:essay-7', 'essay-7'),
    sentence('sentence-preview:123'),
  ];
  // An unsaved example's preview id is listed, but the library never holds it, so it is never gone.
  assert.deepEqual(ownSentenceIds(run), ['own', 'sentence-preview:123']);
});

interface Props {
  viewIds: readonly string[];
  liveNow: LiveIds | null;
  onRemoveFromView: ((id: string) => void) | undefined;
}

/**
 * Renders useLeaveGoneItems in a component that draws nothing, with just enough of a browser for React, as in
 * sentence-analysis-state.test.ts. Each `show` is a render of the view: the ids it shows, and the library's.
 */
async function leaveHarness() {
  const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const removed: string[] = [];
  const takeOut = (id: string) => { removed.push(id); };
  const View = ({ viewIds, liveNow, onRemoveFromView }: Props) => {
    useLeaveGoneItems(viewIds, liveNow, onRemoveFromView);
    return null;
  };
  return {
    removed,
    /** Renders the view showing `viewIds` over a library holding `live`, with App able to take items out or not. */
    show: (viewIds: readonly string[], live: readonly string[] | null, { appTakesOut = true } = {}) =>
      act(() => root.render(createElement(View, {
        viewIds, liveNow: live && new Set(live), onRemoveFromView: appTakesOut ? takeOut : undefined,
      }))),
    close: async () => {
      await act(() => root.unmount());
      delete globals.window;
      delete globals.document;
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

test('a card deleted on another device is taken out of the view once, however often the view renders before it goes', async () => {
  const view = await leaveHarness();
  try {
    await view.show(['a', 'b', 'c'], ['a', 'b', 'c', 'other']);
    assert.deepEqual(view.removed, []);
    // A pull brings the deletion: the view still shows the card, the library no longer holds it.
    await view.show(['a', 'b', 'c'], ['a', 'c', 'other']);
    assert.deepEqual(view.removed, ['b']);
    await view.show(['a', 'b', 'c'], ['a', 'c', 'other']);
    assert.deepEqual(view.removed, ['b'], 'asked once');
    // App took it out; then two go at once, in the view's order.
    await view.show(['a', 'c'], ['a', 'c', 'other']);
    await view.show(['a', 'c'], ['other']);
    assert.deepEqual(view.removed, ['b', 'a', 'c']);
  } finally {
    await view.close();
  }
});

test('a delete made here, which takes the card out of the view as it leaves the library, asks nothing, and its undo still works', async () => {
  const view = await leaveHarness();
  try {
    await view.show(['a', 'b'], ['a', 'b']);
    await view.show(['a'], ['a']);
    // The undo puts the card back in both, and a deletion from another device later still takes it out.
    await view.show(['a', 'b'], ['a', 'b']);
    assert.deepEqual(view.removed, []);
    await view.show(['a', 'b'], ['a']);
    assert.deepEqual(view.removed, ['b']);
  } finally {
    await view.close();
  }
});

test('a card the library never held stays, and one saved while open leaves when another device deletes it', async () => {
  const view = await leaveHarness();
  try {
    // An unsaved card from a search, or an example's preview.
    await view.show(['unsaved'], []);
    await view.show(['unsaved'], ['other']);
    assert.deepEqual(view.removed, []);
    await view.show(['unsaved'], ['unsaved']);
    await view.show(['unsaved'], []);
    assert.deepEqual(view.removed, ['unsaved']);
  } finally {
    await view.close();
  }
});

test('until App passes onRemoveFromView a deleted card stays open, as before', async () => {
  const view = await leaveHarness();
  try {
    await view.show(['a', 'b'], ['a', 'b'], { appTakesOut: false });
    await view.show(['a', 'b'], ['a'], { appTakesOut: false });
    // The word view gathers no live ids then; nothing is asked either way.
    await view.show(['a', 'b'], null);
    assert.deepEqual(view.removed, []);
  } finally {
    await view.close();
  }
});
