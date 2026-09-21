import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancedVocabContentHash,
  collectIncrementalEnrichmentItems,
  hasCurrentLocalAdvancedEnrichment,
  hasCurrentLocalImageEnrichment,
  hasCompleteVocabContent,
  imagePromptHash,
  incrementalEnrichmentItemKey,
  selectReplacementVocab,
  selectUnattemptedIncrementalItems,
  summarizeIncrementalEnrichmentBacklog,
} from '../src/incremental-enrichment.js';

const withAdvancedEnrichment = (data: any) => ({
  ...data,
  advancedEnrichment: {
    version: 1,
    provider: 'local-mlx',
    model: 'local-test-model',
    generatedAt: 1,
    contentHash: advancedVocabContentHash(data),
  },
});

const withLocalImageEnrichment = (data: any) => ({
  ...data,
  localImageEnrichment: {
    version: 1,
    provider: 'local-ernie',
    model: 'local-test-image-model',
    generatedAt: 1,
    promptHash: imagePromptHash(data.imagePrompt),
  },
});

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

test('incremental enrichment prioritizes recent records and still drains the historical backlog', () => {
  const items = [
    { type: 'sentence', savedAt: 99, data: { id: 'legacy', text: 'Old.', sourceWord: '' } },
    { type: 'vocab', savedAt: 98, data: { id: 'legacy-incomplete-word', word: 'old' } },
    { type: 'vocab', savedAt: 97, data: { id: 'legacy-image-gap', word: 'pictured', imagePrompt: 'A picture.' } },
    { type: 'vocab', savedAt: 101, data: { ...completeVocab, id: 'complete', imageUrl: 'server:has_image' } },
    {
      type: 'vocab', savedAt: 101.5,
      data: withLocalImageEnrichment(withAdvancedEnrichment({
        ...completeVocab, id: 'locally-enriched', imageUrl: 'server:has_image',
      })),
    },
    { type: 'sentence', savedAt: 103, data: { id: 'new-sentence', text: 'New.', sourceWord: '' } },
    { type: 'sentence', savedAt: 102.5, data: {
      id: 'legacy-analysis', text: 'New.', sourceWord: '', analysis: legacySentenceAnalysis, imageUrl: 'server:has_image',
    } },
    { type: 'vocab', savedAt: 102, data: { id: 'new-word', word: 'new' } },
    { type: 'sentence', savedAt: 104, isArchived: true, data: { id: 'archived', text: 'Skip.', sourceWord: '' } },
  ];

  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 10).map(item => item.data.id),
    ['complete', 'new-word', 'legacy-analysis', 'new-sentence', 'legacy-image-gap', 'legacy'],
  );
  assert.deepEqual(
    collectIncrementalEnrichmentItems(items, 100, 1).map(item => item.data.id),
    ['complete'],
  );
});

test('vocabulary completeness and sense-matched replacement are deterministic', () => {
  assert.equal(hasCompleteVocabContent(completeVocab), true);
  const enriched = withAdvancedEnrichment(completeVocab);
  assert.equal(hasCurrentLocalAdvancedEnrichment(enriched), true);
  const locallyImaged = withLocalImageEnrichment(enriched);
  assert.equal(hasCurrentLocalAdvancedEnrichment(locallyImaged), true);
  assert.equal(hasCurrentLocalImageEnrichment(locallyImaged), true);
  assert.equal(hasCurrentLocalImageEnrichment({ ...locallyImaged, imagePrompt: 'A changed prompt.' }), false);
  assert.equal(hasCurrentLocalAdvancedEnrichment({ ...enriched, definition: 'Edited later.' }), false);
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

test('incremental enrichment summarizes actionable gap types', () => {
  const items = [
    { type: 'sentence', savedAt: 90, data: { id: 'sentence', text: 'Old.' } },
    { type: 'vocab', savedAt: 110, data: { id: 'new-word', word: 'new' } },
    { type: 'vocab', savedAt: 80, data: { id: 'old-image', imagePrompt: 'An icon.' } },
    { type: 'phrase', savedAt: 70, data: {
      id: 'phrase',
      imagePrompt: 'A scene.',
      vocabs: [{ id: 'nested', imagePrompt: 'An icon.' }],
    } },
  ];

  assert.deepEqual(summarizeIncrementalEnrichmentBacklog(items, 100), {
    items: 4,
    recentItems: 1,
    historicalItems: 3,
    byType: { sentence: 1, vocab: 2, phrase: 1 },
    gaps: {
      sentenceDetailedAnalysis: 1,
      sentenceImage: 1,
      recentVocabContent: 1,
      recentVocabAdvanced: 1,
      recentNestedVocabAdvanced: 0,
      recentVocabLocalImage: 0,
      recentPhraseLocalImage: 0,
      recentNestedVocabLocalImage: 0,
      vocabImage: 1,
      phraseImage: 1,
      nestedVocabImage: 1,
    },
  });
});
