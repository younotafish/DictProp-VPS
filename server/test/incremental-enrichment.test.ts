import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectIncrementalEnrichmentItems,
  hasCompleteVocabContent,
  incrementalEnrichmentItemKey,
  selectReplacementVocab,
  selectUnattemptedIncrementalItems,
} from '../src/incremental-enrichment.js';

const legacySentenceAnalysis = {
  translation: '新的。',
  naturalSpeechIpa: '/nuː/',
  americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of something new, without text.',
};

const completeVocab = {
  id: 'word',
  word: 'word',
  sense: 'noun: unit of language',
  chinese: '词',
  ipa: '/wɝd/',
  definition: 'A distinct unit of language with meaning or grammatical function.',
  forms: ['word', 'words'],
  wordFamily: [{ word: 'wording', pos: 'noun', chinese: '措辞' }],
  history: 'From Old English word, with cognates across the Germanic languages.',
  register: 'Common in every register of present-day English.',
  mnemonic: 'A word is one unit you can put into a sentence.',
  imagePrompt: 'A clean educational icon showing one highlighted word in a row of language symbols.',
  synonyms: [],
  antonyms: [],
  confusables: [],
  examples: [
    'I need one better {{word}} before I send this message to the whole team.',
    'That {{word}} makes the instructions way easier to understand.',
  ],
  usageAudit: {
    status: 'current_general',
    reason: 'A basic and current term throughout American English.',
    confidence: 'high',
    auditedAt: 1,
  },
};

test('incremental enrichment selects only unfinished records added after installation', () => {
  const items = [
    { type: 'sentence', savedAt: 99, data: { id: 'legacy', text: 'Old.', sourceWord: '' } },
    { type: 'vocab', savedAt: 101, data: { ...completeVocab, id: 'complete', imageUrl: 'server:has_image' } },
    { type: 'sentence', savedAt: 103, data: { id: 'new-sentence', text: 'New.', sourceWord: '' } },
    { type: 'sentence', savedAt: 102.5, data: {
      id: 'legacy-analysis', text: 'New.', sourceWord: '', analysis: legacySentenceAnalysis, imageUrl: 'server:has_image',
    } },
    { type: 'vocab', savedAt: 102, data: { id: 'new-word', word: 'new' } },
    { type: 'sentence', savedAt: 104, isArchived: true, data: { id: 'archived', text: 'Skip.', sourceWord: '' } },
  ];

  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 10).map(item => item.data.id),
    ['new-word', 'legacy-analysis', 'new-sentence'],
  );
  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 1).map(item => item.data.id),
    ['new-word'],
  );
});

test('vocabulary completeness and sense-matched replacement are deterministic', () => {
  assert.equal(hasCompleteVocabContent(completeVocab), true);
  assert.equal(hasCompleteVocabContent({ ...completeVocab, examples: ['only one'] }), false);
  const replacement = selectReplacementVocab(
    { word: 'bank', sense: 'verb: rely' },
    [
      { word: 'bank', sense: 'noun: finance' },
      { word: 'bank', sense: 'verb: rely' },
    ],
  );
  assert.equal(replacement?.sense, 'verb: rely');
});

test('a failed first batch cannot starve newer incremental candidates', () => {
  const pending = Array.from({ length: 12 }, (_, index) => ({
    type: 'sentence',
    data: { id: `sentence-${index}` },
  }));
  const attempted = new Set(pending.slice(0, 8).map(incrementalEnrichmentItemKey));

  assert.deepEqual(
    selectUnattemptedIncrementalItems(pending, attempted, 8).map(item => item.data.id),
    ['sentence-8', 'sentence-9', 'sentence-10', 'sentence-11'],
  );
});
