import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSentenceStoredItem, makeVocabStoredItem, sameItemContent } from '../../services/items.ts';
import type { SentenceAnalysis, SentenceData, VocabCard } from '../../types.ts';

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
