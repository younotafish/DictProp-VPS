import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useLibraryActions } from '../../hooks/useLibraryActions.ts';
import { useUndoOffer, type UndoOffer } from '../../hooks/useUndoOffer.ts';
import { makeVocabStoredItem } from '../../services/items.ts';
import type { SearchResult, SRSData, StoredItem, VocabCard } from '../../types.ts';

// hooks/useLibraryActions.ts, run once through a server render. Its handlers keep working afterwards: they close over
// the fakes below, which hold the library and record what the handlers ask of them. With the real undo offer
// (hooks/useUndoOffer.ts) beside it, as App has it, the offer's 6-second timer goes through window.setTimeout, which
// each test's mock clock drives.
(globalThis as { window?: unknown }).window = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

const schedule = (id: string, totalReviews = 0): SRSData => ({
  id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0.5,
});
const vocab = (id: string, word: string, sense: string | undefined, definition = `${word}, ${sense}`): VocabCard => ({
  id, word, sense, chinese: '', ipa: '', definition, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
});
const saved = (data: VocabCard, fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab', data, srs: schedule(data.id, 3), savedAt: 1, updatedAt: 1, ...fields,
});

function renderActions(initial: StoredItem[], { withUndoOffer = false } = {}) {
  let items = initial;
  const calls: string[] = [];
  // As useLibrary's: an update that replaces no item keeps the library array.
  const updateItems = (transform: (current: StoredItem[]) => StoredItem[]): StoredItem[] => {
    const next = transform(items);
    if (next.length === items.length && next.every((item, index) => item === items[index])) return items;
    return (items = next);
  };
  const library = {
    userId: 'u1',
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    updateItems,
    replaceItem: (id: string, update: (item: StoredItem) => StoredItem) => {
      let replaced: StoredItem | undefined;
      updateItems(current => {
        const index = current.findIndex(item => item.data.id === id);
        if (index < 0) return current;
        replaced = update(current[index]);
        return current.map((item, at) => (at === index ? replaced! : item));
      });
      return replaced;
    },
    persistChangedItems: async (changed: StoredItem[], label: string) => { calls.push(`persist ${label} ${changed.map(item => item.data.id).join(',')}`); },
    holdFromPush: (ids: readonly string[] | null) => { calls.push(`hold ${ids?.length ? ids.join(',') : 'none'}`); },
    pushDirtyItems: async (ids?: ReadonlySet<string>) => { calls.push(`push ${[...ids ?? []].join(',')}`); return 0; },
    storeItemUpdates: async (stored: StoredItem[]) => { calls.push(`store ${stored.map(item => item.data.id).join(',')}`); },
  };
  const detail = {
    removeFromDetailView: (remove: () => void) => { remove(); return undefined; },
    removeItemFromDetailContext: () => {},
    removeSentenceFromDetailContext: () => {},
    detailVersionRef: { current: 0 },
    updateDetailContext: () => {},
  };
  // The offers made, and the undo offer itself when it's the real one.
  const offers: UndoOffer[] = [];
  let undoOffer: ReturnType<typeof useUndoOffer> | undefined;
  let actions: ReturnType<typeof useLibraryActions> | undefined;
  const Probe = () => {
    if (!withUndoOffer) {
      actions = useLibraryActions(library, detail, {
        offerUndo: (verb: string, before: StoredItem) => { calls.push(`offer ${verb} ${before.data.id}`); },
        offerUndoChange: () => {},
      });
      return null;
    }
    const offer = useUndoOffer(library, detail);
    undoOffer = offer;
    actions = useLibraryActions(library, detail, {
      offerUndo: offer.offerUndo,
      offerUndoChange: change => { offers.push(change); offer.offerUndoChange(change); },
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return { actions: actions!, undoOffer, offers, calls, library, items: () => items };
}

test('a word saved over its saved sense lands on that card, and another sense label gets a card of its own', () => {
  const { actions, items } = renderActions([saved(vocab('w1', 'Gamut', 'noun: range'))]);
  actions.handleSave(makeVocabStoredItem(vocab('fresh-1', ' gamut', 'noun: range', 'the whole range')));
  assert.equal(items().length, 1, 'the spelling matches ignoring case and space, and the label exactly');
  assert.equal(items()[0].data.id, 'w1', 'under the saved card\'s id');
  assert.equal((items()[0].data as VocabCard).definition, 'the whole range');

  actions.handleSave(makeVocabStoredItem(vocab('fresh-2', 'gamut', 'Noun: range')));
  assert.deepEqual(items().map(item => item.data.id), ['fresh-2', 'w1'], 'a label differing in case is another meaning');
});

test('a missing sense and an empty one are the same meaning, and a phrase never lands on a word with its title', () => {
  const { actions, items } = renderActions([saved(vocab('w1', 'gamut', undefined))]);
  actions.handleSave(makeVocabStoredItem(vocab('fresh', 'gamut', '')));
  assert.deepEqual(items().map(item => item.data.id), ['w1']);

  const phrase: StoredItem = {
    type: 'phrase', savedAt: 2, srs: { ...schedule('p1'), type: 'phrase' },
    data: { id: 'p1', query: 'gamut', translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 2 },
  };
  actions.handleSave(phrase);
  assert.deepEqual(items().map(item => item.data.id), ['p1', 'w1']);
});

test('saving a deleted sense again brings the card back with its history', () => {
  const { actions, items } = renderActions([saved(vocab('w1', 'gamut', 'noun: range'), { isDeleted: true, srs: schedule('w1', 5) })]);
  actions.handleSave(makeVocabStoredItem(vocab('fresh', 'gamut', 'noun: range')));
  assert.equal(items().length, 1);
  assert.equal(items()[0].data.id, 'w1');
  assert.equal(items()[0].isDeleted, undefined);
  assert.equal(items()[0].srs.totalReviews, 5, 'the deleted card\'s schedule, not the fresh one');
});

test('a saved sentence is stored as services/items builds it, under a fresh id, with the copy\'s truthy fields', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { actions, items } = renderActions([]);
  actions.handleSaveSentence('Mind the gap.', 'gap', 'noun: space', {
    id: 'catalog-line', text: 'Mind the gap.', sourceWord: 'gap', catalogKind: 'real-life', catalogSentenceId: 'line-1',
    catalogCollectionId: 'london', catalogTitle: '', preferredSpeechStyle: 'casual',
  });
  const [sentence] = items();
  assert.equal(items().length, 1);
  assert.equal(sentence.type, 'sentence');
  assert.notEqual(sentence.data.id, 'catalog-line', 'never the copy\'s id');
  assert.deepEqual(sentence.data, {
    id: sentence.data.id, text: 'Mind the gap.', sourceWord: 'gap', sourceSense: 'noun: space',
    preferredSpeechStyle: 'casual', catalogSentenceId: 'line-1', catalogCollectionId: 'london', catalogKind: 'real-life',
  }, 'an empty title is left out');
  assert.equal(sentence.srs.id, sentence.data.id);
  assert.equal(sentence.srs.type, 'sentence');
  assert.equal(sentence.srs.totalReviews, 0);
  assert.equal(sentence.savedAt, 1_700_000_000_000);
});

test('an automatic write patches a live card and stamps it, and nothing that changes nothing touches the library', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000 });
  const card = saved(vocab('w1', 'gamut', 'noun: range'));
  const { actions, items } = renderActions([card]);
  actions.patchLiveItem('w1', item => ({ ...item, data: { ...item.data, definition: 'patched' } as VocabCard }));
  assert.equal((items()[0].data as VocabCard).definition, 'patched');
  assert.equal(items()[0].updatedAt, 5_000);

  const library = items();
  actions.patchLiveItem('w1', () => null);
  actions.patchLiveItem('w1', item => item);
  actions.patchLiveItem('gone', item => ({ ...item, isArchived: true }));
  assert.equal(items(), library, 'a null patch, the item itself or a missing id leave the same library');
});

test('an automatic write never brings a deleted card back, and its patch is not even asked', () => {
  const deleted = saved(vocab('w1', 'gamut', 'noun: range'), { isDeleted: true });
  const { actions, items } = renderActions([deleted]);
  let asked = 0;
  actions.patchLiveItem('w1', item => { asked++; return { ...item, isDeleted: undefined }; });
  assert.equal(items()[0], deleted);
  assert.equal(asked, 0);
});

test('a refresh saves the fresh result over the word: its cards updated in place on their schedules, new senses first', async () => {
  const river = saved(vocab('w1', 'bank', 'noun: river'), { srs: schedule('w1', 4) });
  const other = saved(vocab('x1', 'gamut', undefined));
  const { actions, items } = renderActions([river, other]);
  await actions.handleRefreshReplace('bank', [
    vocab('ai-1', 'bank', 'noun: money'),
    vocab('ai-2', 'bank', 'noun: river', 'the land beside a river'),
    vocab('ai-3', 'bank', 'verb: tilt'),
  ]);
  assert.deepEqual(items().map(item => item.data.id), ['ai-3', 'ai-1', 'w1', 'x1']);
  assert.equal((items()[2].data as VocabCard).definition, 'the land beside a river');
  assert.equal(items()[2].srs.totalReviews, 4, 'the refreshed card keeps its schedule');
  assert.equal(items()[3], other);
});

test('a refresh that brings no senses saves nothing', async () => {
  const { actions, items } = renderActions([saved(vocab('w1', 'bank', 'noun: river'))]);
  const library = items();
  await actions.handleRefreshReplace('bank', []);
  assert.equal(items(), library);
});

test('a refresh offers to take it back, holding every card it saved, and Undo puts the library back as it was', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const river = saved(vocab('w1', 'bank', 'noun: river'), { srs: schedule('w1', 4), lastSyncedHash: 'synced', serverRevision: 3 });
  const other = saved(vocab('x1', 'gamut', undefined));
  const { actions, undoOffer, offers, calls, items } = renderActions([river, other], { withUndoOffer: true });
  await actions.handleRefreshReplace(' bank ', [
    vocab('ai-1', 'bank', 'noun: money'),
    vocab('ai-2', 'bank', 'noun: river', 'the land beside a river'),
    vocab('ai-3', 'bank', 'verb: tilt'),
  ]);
  assert.deepEqual(offers.map(offer => [offer.message, offer.ids]), [['Refreshed “bank”', ['w1', 'ai-1', 'ai-3']]]);
  assert.deepEqual(calls, ['hold w1,ai-1,ai-3'], 'held on this device, and nothing pushed yet');

  await undoOffer!.undoLastChange();
  assert.equal(items().find(item => item.data.id === 'w1'), river, 'the refreshed card exactly as it was');
  assert.deepEqual(items().filter(item => item.isDeleted).map(item => [item.data.id, item.updatedAt]), [['ai-3', 10_000], ['ai-1', 10_000]], 'the added cards deleted');
  assert.equal(items().find(item => item.data.id === 'x1'), other);
  assert.deepEqual(calls.slice(1), ['hold none', 'push w1,ai-1,ai-3', 'store w1,ai-1,ai-3']);
});

test('a card reviewed between the refresh and Undo keeps its new schedule and gets its old content back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const river = saved(vocab('w1', 'bank', 'noun: river'), { srs: schedule('w1', 4) });
  const { actions, undoOffer, library, items } = renderActions([river], { withUndoOffer: true });
  await actions.handleRefreshReplace('bank', [vocab('ai-2', 'bank', 'noun: river', 'the land beside a river')]);
  const reviewedSrs = schedule('w1', 5);
  library.replaceItem('w1', item => ({ ...item, srs: reviewedSrs, updatedAt: 10_500 }));
  t.mock.timers.tick(1_000);
  await undoOffer!.undoLastChange();
  const [card] = items();
  assert.equal(card.data, river.data);
  assert.equal(card.srs, reviewedSrs);
  assert.equal(card.updatedAt, 11_000);
});

test('the offer closes after six seconds and sends the refresh on; a refresh none of whose saves lands offers nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const { actions, offers, calls } = renderActions([saved(vocab('w1', 'bank', 'noun: river'))], { withUndoOffer: true });
  await actions.handleRefreshReplace('bank', [vocab('ai-1', 'bank', 'noun: money')]);
  t.mock.timers.tick(6_000);
  assert.deepEqual(calls, ['hold ai-1', 'hold none', 'push ai-1']);

  await actions.handleRefreshReplace('bank', [vocab('ai-2', '', 'noun: money')]);
  assert.equal(offers.length, 1, 'a card with no word is never saved, so there is nothing to take back');
});

const phraseOf = (vocabs: VocabCard[], fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'phrase', savedAt: 1, updatedAt: 1, srs: { ...schedule('p1'), type: 'phrase' },
  data: { id: 'p1', query: 'limpid prose', translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs, timestamp: 1 },
  ...fields,
});
const vocabIds = (item: StoredItem) => (item.data as SearchResult).vocabs.map(v => v.id);

test('removing a vocab from a phrase offers to take it back, holding the phrase, and Undo puts the vocab back in its place', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const phrase = phraseOf(
    [vocab('v1', 'limpid', undefined), vocab('v2', 'prose', undefined), vocab('v3', 'lucid', undefined)],
    { lastSyncedHash: 'synced', serverRevision: 3 },
  );
  const { actions, undoOffer, offers, calls, items } = renderActions([phrase], { withUndoOffer: true });
  await actions.handleRemoveVocabFromPhrase('p1', 'v2');
  assert.deepEqual(vocabIds(items()[0]), ['v1', 'v3']);
  assert.equal(items()[0].updatedAt, 10_000);
  assert.deepEqual(offers.map(offer => [offer.message, offer.ids]), [['Removed “prose”', ['p1']]]);
  assert.deepEqual(calls, ['hold p1', 'persist Remove vocab p1'], 'held on this device before it is stored and pushed');

  await undoOffer!.undoLastChange();
  assert.deepEqual(items()[0], phrase, 'the phrase as it was');
  assert.deepEqual(calls.slice(2), ['hold none', 'push p1', 'store p1']);
});

test('a removal is sent on when its offer closes, and a phrase keeps its last vocab', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const { actions, offers, calls, items } = renderActions(
    [phraseOf([vocab('v1', 'limpid', undefined), vocab('v2', 'prose', undefined)])],
    { withUndoOffer: true },
  );
  await actions.handleRemoveVocabFromPhrase('p1', 'v1');
  t.mock.timers.tick(6_000);
  assert.deepEqual(calls, ['hold p1', 'persist Remove vocab p1', 'hold none', 'push p1']);

  const library = items();
  await actions.handleRemoveVocabFromPhrase('p1', 'v2');
  await actions.handleRemoveVocabFromPhrase('p1', 'gone');
  assert.equal(items(), library, 'the last vocab stays, and a vocab the phrase lacks changes nothing');
  assert.equal(offers.length, 1);
});

test('Undo after a second removal from a phrase puts back only that vocab, and none that is back already', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const { actions, undoOffer, library, items } = renderActions(
    [phraseOf([vocab('v1', 'limpid', undefined), vocab('v2', 'prose', undefined), vocab('v3', 'lucid', undefined)])],
    { withUndoOffer: true },
  );
  await actions.handleRemoveVocabFromPhrase('p1', 'v1');
  t.mock.timers.tick(1_000);
  await actions.handleRemoveVocabFromPhrase('p1', 'v3');
  await undoOffer!.undoLastChange();
  assert.deepEqual(vocabIds(items()[0]), ['v2', 'v3']);
  assert.equal(items()[0].updatedAt, 10_000, 'as the first removal left it');

  // Another device's copy, pulled before Undo, already has the vocab.
  await actions.handleRemoveVocabFromPhrase('p1', 'v2');
  const pulled = library.replaceItem('p1', item => ({
    ...item,
    data: { ...item.data, vocabs: [vocab('v2', 'prose', undefined), vocab('v3', 'lucid', undefined)] } as SearchResult,
    updatedAt: 20_000,
  }));
  await undoOffer!.undoLastChange();
  assert.equal(items()[0], pulled);
});
