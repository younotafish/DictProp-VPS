import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancedVocabContentHash,
  hasCurrentLocalAdvancedEnrichment,
  hasCurrentLocalImageEnrichment,
  hasCompleteVocabContent,
  imagePromptHash,
  localImageMarker,
  summarizeIncrementalEnrichmentBacklog,
} from '../src/incremental-enrichment.js';
import { completeVocab } from './support/fixtures.js';

const withAdvancedEnrichment = (data: Record<string, unknown>) => ({
  ...data,
  advancedEnrichment: {
    version: 1,
    provider: 'codex-harness',
    model: 'gpt-5.6-sol',
    generatedAt: 1,
    contentHash: advancedVocabContentHash(data),
  },
});

const withLocalImageEnrichment = (data: Record<string, unknown>) => ({
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


test('vocabulary completeness and the local enrichment markers are deterministic', () => {
  assert.equal(hasCompleteVocabContent(completeVocab), true);
  const enriched = withAdvancedEnrichment(completeVocab);
  assert.equal(hasCurrentLocalAdvancedEnrichment(enriched), true);
  const locallyImaged = withLocalImageEnrichment(enriched);
  assert.equal(hasCurrentLocalAdvancedEnrichment(locallyImaged), true);
  assert.equal(hasCurrentLocalImageEnrichment(locallyImaged), true);
  assert.equal(hasCurrentLocalImageEnrichment({ ...locallyImaged, imagePrompt: 'A changed prompt.' }), false);
  assert.equal(hasCurrentLocalAdvancedEnrichment({ ...enriched, definition: 'Edited later.' }), false);
  assert.equal(hasCurrentLocalAdvancedEnrichment({
    ...enriched,
    advancedEnrichment: { ...enriched.advancedEnrichment, provider: 'claude-code', model: 'claude-opus-5-5' },
  }), true);
  assert.equal(hasCurrentLocalAdvancedEnrichment({
    ...completeVocab,
    advancedEnrichment: {
      ...enriched.advancedEnrichment,
      provider: 'local-mlx',
    },
  }), false);
  assert.equal(hasCompleteVocabContent({ ...completeVocab, examples: ['only one'] }), false);
});

test('a locally drawn image\'s marker is current for the prompt it was drawn for', () => {
  const marker = localImageMarker('krea/Krea-2-Turbo', 200, imagePromptHash(completeVocab.imagePrompt));
  // The key order is part of the card's corpus source hash, which every later import checks.
  assert.deepEqual(Object.keys(marker), ['version', 'provider', 'model', 'generatedAt', 'promptHash']);
  assert.equal(marker.provider, 'local-ernie');
  assert.equal(hasCurrentLocalImageEnrichment({ ...completeVocab, localImageEnrichment: marker }), true);
  assert.equal(hasCurrentLocalImageEnrichment({ ...completeVocab, imagePrompt: 'Another.', localImageEnrichment: marker }), false);
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
      recentNestedVocabContent: 0,
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

const noGaps = {
  sentenceDetailedAnalysis: 0,
  sentenceImage: 0,
  recentVocabContent: 0,
  recentVocabAdvanced: 0,
  recentNestedVocabContent: 0,
  recentNestedVocabAdvanced: 0,
  recentVocabLocalImage: 0,
  recentPhraseLocalImage: 0,
  recentNestedVocabLocalImage: 0,
  vocabImage: 0,
  phraseImage: 0,
  nestedVocabImage: 0,
};

test('the backlog owes recent items everything and older ones only their stored images', () => {
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
    { type: 'vocab', savedAt: 104, data: withAdvancedEnrichment({ ...completeVocab, id: 'awaiting-local-image', imageUrl: 'server:has_image' }) },
    { type: 'sentence', savedAt: 103, data: { id: 'new-sentence', text: 'New.', sourceWord: '' } },
    { type: 'sentence', savedAt: 102.5, data: {
      id: 'legacy-analysis', text: 'New.', sourceWord: '', analysis: legacySentenceAnalysis, imageUrl: 'server:has_image',
    } },
    { type: 'vocab', savedAt: 102, data: { id: 'new-word', word: 'new' } },
    { type: 'sentence', savedAt: 104, isArchived: true, data: { id: 'archived', text: 'Skip.', sourceWord: '' } },
    { type: 'vocab', savedAt: 104, isDeleted: true, data: { id: 'deleted', word: 'gone' } },
  ];

  assert.deepEqual(summarizeIncrementalEnrichmentBacklog(items, 100), {
    items: 7,
    recentItems: 5,
    historicalItems: 2,
    byType: { sentence: 3, vocab: 4, phrase: 0 },
    gaps: {
      ...noGaps,
      sentenceDetailedAnalysis: 3,
      sentenceImage: 2,
      recentVocabContent: 1,
      recentVocabAdvanced: 2,
      recentVocabLocalImage: 1,
      vocabImage: 1,
    },
  });
});

test('a phrase owes its own image and its cards\' gaps, and a recent one its local image once a card is enriched', () => {
  const items = [
    {
      type: 'phrase',
      savedAt: 150,
      data: {
        id: 'p-recent',
        query: 'a recent phrase',
        imagePrompt: 'A scene.',
        vocabs: [
          // Marked as enriched, but its examples were cut down afterwards: incomplete content, current marker.
          withAdvancedEnrichment({ ...completeVocab, id: 'card-a', examples: ['only one'] }),
          { id: 'card-b', word: 'b' },
          withLocalImageEnrichment(withAdvancedEnrichment({ ...completeVocab, id: 'card-c', imageUrl: 'server:has_image' })),
        ],
      },
    },
    {
      type: 'phrase',
      savedAt: 50,
      data: {
        id: 'p-old',
        query: 'an old phrase',
        imagePrompt: 'Old scene.',
        imageUrl: 'server:has_image',
        vocabs: [{ id: 'card-d', word: 'd', imagePrompt: 'A picture.' }, { id: 'card-e', word: 'e' }],
      },
    },
    { type: 'phrase', savedAt: 60, data: { id: 'p-old-done', query: 'done', vocabs: [{ id: 'card-f', word: 'f' }] } },
    { type: 'phrase', savedAt: 160, data: { id: 'p-no-cards', query: 'no cards', imagePrompt: 'A scene.', vocabs: 'none' } },
    { type: 'phrase', savedAt: 170, isArchived: true, data: { id: 'p-archived', query: 'archived', imagePrompt: 'A scene.', vocabs: [] } },
  ];

  assert.deepEqual(summarizeIncrementalEnrichmentBacklog(items, 100), {
    items: 3,
    recentItems: 2,
    historicalItems: 1,
    byType: { sentence: 0, vocab: 0, phrase: 3 },
    gaps: {
      ...noGaps,
      recentNestedVocabContent: 2,
      recentNestedVocabAdvanced: 1,
      recentPhraseLocalImage: 1,
      recentNestedVocabLocalImage: 1,
      phraseImage: 2,
      nestedVocabImage: 2,
    },
  });
  // A card whose only gap is its content makes its phrase pending, and the nested content counter says why.
  const { imagePrompt: _prompt, ...unprompted } = completeVocab;
  const contentOnly = withAdvancedEnrichment({ ...unprompted, id: 'card-g', examples: ['only one'] });
  const summary = summarizeIncrementalEnrichmentBacklog([
    { type: 'phrase', savedAt: 150, data: { id: 'p-content', query: 'content only', vocabs: [contentOnly] } },
  ], 100);
  assert.equal(summary.items, 1);
  assert.deepEqual(summary.gaps, { ...noGaps, recentNestedVocabContent: 1 });
});
