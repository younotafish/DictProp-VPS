import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useLibraryActions } from '../../hooks/useLibraryActions.ts';
import { makeVocabStoredItem } from '../../services/items.ts';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';

// hooks/useLibraryActions.ts, run once through a server render. Its handlers keep working afterwards: they close over
// the fakes below, which hold the library and record what the handlers ask of them.

const schedule = (id: string, totalReviews = 0): SRSData => ({
  id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0.5,
});
const vocab = (id: string, word: string, sense: string | undefined, definition = `${word}, ${sense}`): VocabCard => ({
  id, word, sense, chinese: '', ipa: '', definition, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
});
const saved = (data: VocabCard, fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab', data, srs: schedule(data.id, 3), savedAt: 1, updatedAt: 1, ...fields,
});

function renderActions(initial: StoredItem[]) {
  let items = initial;
  const calls: string[] = [];
  const library = {
    userId: 'u1',
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    updateItems: (transform: (current: StoredItem[]) => StoredItem[]) => (items = transform(items)),
    replaceItem: (id: string, update: (item: StoredItem) => StoredItem) => {
      const index = items.findIndex(item => item.data.id === id);
      if (index < 0) return undefined;
      const next = update(items[index]);
      items = items.map((item, at) => (at === index ? next : item));
      return next;
    },
    persistChangedItems: async (changed: StoredItem[], label: string) => { calls.push(`persist ${label} ${changed.map(item => item.data.id).join(',')}`); },
  };
  const detail = {
    removeFromDetailView: (remove: () => void) => { remove(); return undefined; },
    removeItemFromDetailContext: () => {},
    removeSentenceFromDetailContext: () => {},
  };
  const undo = { offerUndo: (verb: string, before: StoredItem) => { calls.push(`offer ${verb} ${before.data.id}`); } };
  let actions: ReturnType<typeof useLibraryActions> | undefined;
  const Probe = () => { actions = useLibraryActions(library, detail, undo); return null; };
  renderToStaticMarkup(createElement(Probe));
  return { actions: actions!, calls, items: () => items };
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
