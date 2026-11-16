import assert from 'node:assert/strict';
import test from 'node:test';
import { saveNewSenses, savedSenseKeys } from '../../services/senseSaving.ts';
import { savedVocabKey, type StoredItem, type VocabCard } from '../../types.ts';

const vocab = (word: string, sense?: string, id = `${word}-${sense ?? 'main'}`): VocabCard => ({
  id, word, sense, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
});
const saved = (card: VocabCard, fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: card,
  srs: { id: card.id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  ...fields,
});

/** saveNewSenses with a recording save. */
const saveInto = (store: StoredItem[]) => (item: StoredItem) => { store.push(item); };

test('the library holds the senses of its word cards that are not deleted', () => {
  const phrase = { ...saved(vocab('run out of')), type: 'phrase' } as StoredItem;
  const sentence = { ...saved(vocab('It rained.')), type: 'sentence' } as StoredItem;
  const keys = savedSenseKeys([
    saved(vocab('Bank', 'noun: money')),
    saved(vocab('bank', 'noun: river edge'), { isArchived: true }),
    saved(vocab('pear'), { isDeleted: true }),
    phrase,
    sentence,
  ]);
  assert.deepEqual([...keys], [savedVocabKey(vocab('bank', 'noun: money')), savedVocabKey(vocab('bank', 'noun: river edge'))]);
});

test('a sense the library holds is skipped, a new one is saved as a fresh card', () => {
  const seen = savedSenseKeys([saved(vocab('bank', 'noun: money'))]);
  const store: StoredItem[] = [];
  const money = vocab(' BANK ', 'noun: money', 'ai-1');
  const edge = vocab('bank', 'noun: river edge', 'ai-2');
  assert.deepEqual(saveNewSenses([money, edge], seen, saveInto(store)), [edge]);
  assert.equal(store.length, 1);
  assert.equal(store[0].type, 'vocab');
  assert.equal(store[0].data, edge, 'the card holds the analysis as it came');
  assert.equal(store[0].srs.id, 'ai-2');
  assert.equal(store[0].srs.totalReviews, 0, 'with a new schedule');
  assert.ok(seen.has(savedVocabKey(edge)), 'and the run now counts it as saved');
});

test('a sense repeated within one result, or across two results, is saved once', () => {
  const seen = savedSenseKeys([]);
  const store: StoredItem[] = [];
  const save = saveInto(store);
  const first = saveNewSenses([vocab('bank', 'money', 'ai-1'), vocab('bank', 'money', 'ai-2'), vocab('bank', 'edge', 'ai-3')], seen, save);
  const second = saveNewSenses([vocab('Bank', 'money', 'ai-4'), vocab('banks', 'money', 'ai-5')], seen, save);
  assert.deepEqual(first.map(card => card.id), ['ai-1', 'ai-3']);
  assert.deepEqual(second.map(card => card.id), ['ai-5'], "another word's sense is another card");
  assert.deepEqual(store.map(item => item.data.id), ['ai-1', 'ai-3', 'ai-5']);
});

test('the sense label counts exactly, so labels that differ in case are two cards', () => {
  const store: StoredItem[] = [];
  const saves = saveNewSenses([vocab('feeling', 'Noun: emotion'), vocab('feeling', 'noun: emotion'), vocab('feeling')], new Set(), saveInto(store));
  assert.equal(saves.length, 3);
  assert.equal(store.length, 3);
});

test('a result with nothing new saves nothing', () => {
  const store: StoredItem[] = [];
  const seen = savedSenseKeys([saved(vocab('apple'))]);
  assert.deepEqual(saveNewSenses([vocab('apple', undefined, 'ai-9')], seen, saveInto(store)), []);
  assert.deepEqual(saveNewSenses([], seen, saveInto(store)), []);
  assert.deepEqual(store, []);
});
