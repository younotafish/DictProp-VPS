import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSavedCopy, findSavedCopyIndex, makeSentenceStoredItem, makeVocabStoredItem, sameItemContent, type SavedCopyProbe,
} from '../../services/items.ts';
import type { SearchResult, SentenceAnalysis, SentenceData, StoredItem, VocabCard } from '../../types.ts';

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

test('a newly saved sentence gets a fresh id, the word and sense it came from, a new schedule and a save time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const item = makeSentenceStoredItem('She {{ran}} home.', 'run', 'verb: move fast');
  assert.equal(item.type, 'sentence');
  assert.deepEqual(item.data, { id: item.data.id, text: 'She {{ran}} home.', sourceWord: 'run', sourceSense: 'verb: move fast' });
  assert.notEqual(makeSentenceStoredItem('She {{ran}} home.', 'run').data.id, item.data.id, 'each save gets its own id');
  assert.equal(item.savedAt, 1_700_000_000_000);
  assert.equal(item.srs.id, item.data.id);
  assert.equal(item.srs.type, 'sentence');
  assert.equal(item.srs.totalReviews, 0);
  assert.equal(item.srs.nextReview, 1_700_000_000_000, 'due at once');
});

test('a sentence saved from the copy a screen holds takes its truthy optional fields, never its id, text or schedule', () => {
  const analysis: SentenceAnalysis = {
    translation: '她跑回家。', americanEnglish: { status: 'shared', explanation: '' }, terms: [], imagePrompt: 'a street',
  };
  const prepared: SentenceData = {
    id: 'catalog-line-7', text: 'The catalog text.', sourceWord: 'catalog word', sourceSense: 'catalog sense',
    preferredSpeechStyle: 'casual', catalogKind: 'real-life', catalogSentenceId: 'line-7', catalogCollectionId: 'trip',
    catalogTitle: '', analysis, analysisGeneratedAt: 0, imageUrl: 'idb://catalog-line-7',
    usageAudit: { status: 'modern_american', reason: '', confidence: 'high', auditedAt: 1 },
  };
  const item = makeSentenceStoredItem('She ran home.', 'run', undefined, prepared);
  assert.deepEqual(item.data, {
    id: item.data.id, text: 'She ran home.', sourceWord: 'run', sourceSense: undefined,
    preferredSpeechStyle: 'casual', catalogKind: 'real-life', catalogSentenceId: 'line-7', catalogCollectionId: 'trip',
    analysis, imageUrl: 'idb://catalog-line-7',
  }, 'an empty title and a zero analysis time are left out, as is everything else the copy carries');
  assert.notEqual(item.data.id, prepared.id);
  assert.equal(item.srs.id, item.data.id);
});

const word = (id: string, spelling: string, sense?: string): StoredItem => makeVocabStoredItem({ ...vocab, id, word: spelling, sense });
const phrase = (id: string, query: string): StoredItem => ({
  ...makeVocabStoredItem(vocab),
  type: 'phrase',
  data: { id, query, translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 0 } satisfies SearchResult,
});

test('a saved copy is the item with the same id, else the same spelling and type and, for a word, the exact sense label', () => {
  const items = [
    word('w1', 'Visceral', 'adj: instinctive'),
    word('w2', 'visceral', 'Adj: instinctive'),
    word('w3', 'visceral'),
    phrase('p1', 'Run Down'),
    makeSentenceStoredItem('She ran home.', 'run'),
  ];
  const at = (probe: SavedCopyProbe) => findSavedCopyIndex(items, probe);

  assert.equal(at(word('w2', 'something else entirely')), 1, 'the id wins over every other rule');
  assert.equal(at(word('new', '  VISCERAL ', 'adj: instinctive')), 0, 'spelling ignores case and surrounding space');
  assert.equal(at(word('new', 'visceral', 'adj: Instinctive')), -1, 'the sense label is compared exactly');
  assert.equal(at(word('new', 'visceral', 'Adj: instinctive')), 1);
  assert.equal(at(word('new', 'visceral', '')), 2, 'an empty sense is the missing one');
  assert.equal(at(word('new', 'visceral', 'noun: the gut')), -1, 'another meaning is another card');
  assert.equal(at(phrase('new', 'run down ')), 3);
  assert.equal(at(word('new', 'run down')), -1, 'a word never matches a phrase');
  assert.equal(at(phrase('new', 'visceral')), -1, 'nor a phrase a word');
  assert.equal(at({ type: 'sentence', data: { id: 'new', text: 'she ran home.', sourceWord: 'run' } }), 4, 'a probe needs only type and data');

  assert.equal(findSavedCopy(items, phrase('new', 'RUN DOWN')), items[3]);
  assert.equal(findSavedCopy(items, phrase('new', 'run up')), undefined);
});

test('a deleted copy is still found, so saving a deleted card again brings its history back', () => {
  const deleted: StoredItem = { ...word('old', 'visceral', 'adj: instinctive'), isDeleted: true };
  assert.equal(findSavedCopy([deleted], word('fresh-ai-id', 'visceral', 'adj: instinctive')), deleted);
});
