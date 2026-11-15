import assert from 'node:assert/strict';
import test from 'node:test';
import { makeVocabStoredItem, sameItemContent } from '../../services/items.ts';
import type { VocabCard } from '../../types.ts';

const vocab: VocabCard = {
  id: 'saved-id', word: 'visceral', sense: 'adj: instinctive', chinese: '', ipa: '', definition: 'deep',
  synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
};

test('a freshly saved sense gets a new schedule under its own id and a save time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const item = makeVocabStoredItem(vocab);
  assert.equal(item.type, 'vocab');
  assert.equal(item.data, vocab);
  assert.equal(item.savedAt, 1_700_000_000_000);
  assert.equal(item.srs.id, 'saved-id');
  assert.equal(item.srs.type, 'vocab');
  assert.equal(item.srs.totalReviews, 0);
  assert.equal(item.srs.nextReview, 1_700_000_000_000, 'due at once');
});

test('two copies share their content exactly when they share the content object', () => {
  const item = makeVocabStoredItem(vocab);
  assert.equal(sameItemContent(item, { ...item, isArchived: true }), true, 'archiving replaces only the wrapper');
  assert.equal(sameItemContent(item, { ...item, data: { ...vocab } }), false);
});
