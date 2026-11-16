import assert from 'node:assert/strict';
import test from 'node:test';
import { planRefreshReplace } from '../../services/refreshReplace.ts';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';

// services/refreshReplace.ts: what Refresh with AI saves over a saved word.

const schedule = (id: string, totalReviews: number): SRSData => ({
  id, type: 'vocab', nextReview: 9_000, interval: 3, memoryStrength: 0, lastReviewDate: 8_000, totalReviews, correctStreak: 2, stability: 4,
});
const vocab = (id: string, word: string, sense: string | undefined, fields: Partial<VocabCard> = {}): VocabCard => ({
  id, word, sense, chinese: '', ipa: '', definition: `${word}: ${sense}`, synonyms: [], antonyms: [], confusables: [], examples: [], history: '',
  register: '', mnemonic: '', ...fields,
});
const saved = (data: VocabCard, fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab', data, srs: schedule(data.id, 6), savedAt: 100, updatedAt: 200, serverRevision: 7, lastSyncedHash: 'synced', ...fields,
});

test('a fresh sense the word has a card for updates that card in place, keeping its id, schedule, save time and picture', () => {
  const card = saved(vocab('w1', 'Gamut', 'noun: range', { imageUrl: 'server:has_image:abc' }));
  const fresh = vocab('ai-1', 'gamut', 'noun: range', { definition: 'the complete range' });
  const { updates, created } = planRefreshReplace([card], 'gamut', [fresh]);
  assert.deepEqual(created, []);
  assert.deepEqual(updates, [{ ...card, data: { ...fresh, id: 'w1', imageUrl: 'server:has_image:abc' } }]);
  assert.equal(updates[0].srs, card.srs);
  assert.equal(updates[0].serverRevision, 7, 'the rest of the saved wrapper comes along, for handleSave to rebase on');
});

test('a fresh card that brings its own picture keeps it', () => {
  const card = saved(vocab('w1', 'gamut', 'noun: range', { imageUrl: 'idb:stored' }));
  const fresh = vocab('ai-1', 'gamut', 'noun: range', { imageUrl: 'data:image/png;base64,AAAA' });
  assert.equal(planRefreshReplace([card], 'gamut', [fresh]).updates[0].data.imageUrl, 'data:image/png;base64,AAAA');
});

test('a sense no card has becomes a new card with a schedule of its own', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const card = saved(vocab('w1', 'bank', 'noun: river'));
  const fresh = vocab('ai-2', 'bank', 'noun: money');
  const { updates, created } = planRefreshReplace([card], 'bank', [fresh]);
  assert.deepEqual(updates, []);
  assert.equal(created.length, 1);
  assert.equal(created[0].data, fresh);
  assert.equal(created[0].srs.id, 'ai-2');
  assert.equal(created[0].srs.totalReviews, 0);
  assert.equal(created[0].savedAt, 1_700_000_000_000);
});

test('the labels match exactly, a missing one equals the empty one, and the spelling ignores case and surrounding space', () => {
  const unlabelled = saved(vocab('w1', ' Gamut ', undefined));
  const labelled = saved(vocab('w2', 'gamut', 'noun: range'));
  const { updates, created } = planRefreshReplace([unlabelled, labelled], '  GAMUT', [
    vocab('ai-1', 'gamut', ''),
    vocab('ai-2', 'gamut', 'Noun: range'),
  ]);
  assert.deepEqual(updates.map(item => item.data.id), ['w1']);
  assert.deepEqual(created.map(item => item.data.id), ['ai-2'], 'a label differing in case is another meaning');
});

test('deleted cards, other spellings and phrases are never updated, and the cards the result leaves out stay as they are', () => {
  const deleted = saved(vocab('w1', 'gamut', 'noun: range'), { isDeleted: true });
  const other = saved(vocab('w2', 'gamuts', 'noun: range'));
  const phrase: StoredItem = {
    type: 'phrase', savedAt: 1, srs: { ...schedule('p1', 0), type: 'phrase' },
    data: { id: 'p1', query: 'gamut', translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 1 },
  };
  const leftOut = saved(vocab('w3', 'gamut', 'noun: musical scale'));
  const { updates, created } = planRefreshReplace([deleted, other, phrase, leftOut], 'gamut', [vocab('ai-1', 'gamut', 'noun: range')]);
  assert.deepEqual(updates, []);
  assert.deepEqual(created.map(item => item.data.id), ['ai-1']);
});

test('two fresh senses with one label both update its card, in the result\'s order, so the last one is what stays', () => {
  const card = saved(vocab('w1', 'gamut', 'noun: range'));
  const { updates } = planRefreshReplace([card], 'gamut', [
    vocab('ai-1', 'gamut', 'noun: range', { definition: 'first' }),
    vocab('ai-2', 'gamut', 'noun: range', { definition: 'second' }),
  ]);
  assert.deepEqual(updates.map(item => [item.data.id, (item.data as VocabCard).definition]), [['w1', 'first'], ['w1', 'second']]);
});
