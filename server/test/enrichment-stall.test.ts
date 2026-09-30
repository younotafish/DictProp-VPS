import assert from 'node:assert/strict';
import test from 'node:test';
import { findStalledEnrichment } from '../src/enrichment-stall.js';
import { advancedVocabContentHash } from '../src/incremental-enrichment.js';
import { sentenceLookupHash } from '../src/sentence-enrichment.js';

const HOUR = 60 * 60 * 1_000;
const now = Date.UTC(2026, 8, 28, 12);

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

const withAdvancedEnrichment = (data: any, generatedAt = 1) => ({
  ...data,
  advancedEnrichment: {
    version: 1,
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    generatedAt,
    contentHash: advancedVocabContentHash(data),
  },
});

const completeAnalysis = {
  translation: '这是一个例句。',
  naturalSpeechIpa: '/ðɪs ɪz ə tɛst/',
  grammar: { structure: 'A simple declarative clause.', points: [] },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in American English.',
    evidence: ['The wording is current and idiomatic.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ðɪs ɪz ə tɛst/',
    fastIpa: '/ðɪs ɪz ə tɛst/',
    carefulSpeakerGuide: 'this IS a TEST',
    fastSpeechFeatures: ['The article is reduced in fluent speech.'],
    intonationAndChunking: 'Use one thought group with a final fall.',
    keyDifference: 'Fluent speech reduces the unstressed article.',
  },
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};

const enrichedExamples = completeVocab.examples.map(example => ({
  lookup_hash: sentenceLookupHash(example),
  analysis: JSON.stringify(completeAnalysis),
  image_content_hash: 'image-hash',
}));

test('the stall check stays quiet for a deferred image and for work the next cycle will reach', () => {
  const items = [
    // Its image was deferred three days ago and may never be drawn.
    { type: 'vocab', savedAt: now - 72 * HOUR, data: withAdvancedEnrichment({ ...completeVocab, id: 'deferred' }) },
    // Saved two hours ago: the next cycle will enrich it.
    { type: 'vocab', savedAt: now - 2 * HOUR, data: { id: 'fresh', word: 'fresh' } },
    // Saved yesterday but reviewed an hour ago, which restarts its clock.
    { type: 'vocab', savedAt: now - 30 * HOUR, updatedAt: now - HOUR, data: { id: 'reviewed', word: 'reviewed' } },
  ];

  const stall = findStalledEnrichment(items, () => enrichedExamples, {
    overdueAfterHours: 18, imageGapTolerance: 20, now,
  });

  assert.equal(stall.textGaps, 0);
  // The deferred word owes both its stored image and its locally drawn one.
  assert.equal(stall.imageGaps, 2);
  assert.deepEqual(stall.alerts, []);
});

test('the stall check alerts when an analysis stays missing past the overdue window', () => {
  const items = [{
    type: 'vocab',
    savedAt: now - 20 * HOUR,
    data: { ...completeVocab, id: 'waiting', imageUrl: 'server:has_image' },
  }];

  const stall = findStalledEnrichment(items, () => enrichedExamples, {
    overdueAfterHours: 18, imageGapTolerance: 20, examplesPublishedAt: now - 30 * HOUR, now,
  });

  assert.equal(stall.textGaps, 1);
  assert.equal(stall.imageGaps, 0);
  assert.equal(stall.lastLocalEnrichmentAt, now - 30 * HOUR);
  assert.deepEqual(stall.alerts, [
    '1 analysis has been due for over 18 h, so the local enrichment cycle may have stopped (it last published 30 h ago)',
  ]);
});

test('an example waits on its card\'s clock, and a saved sentence still rules it out', () => {
  const items = [
    {
      type: 'vocab',
      savedAt: now - 400 * HOUR,
      data: { id: 'old-card', examples: ['Keep {{going}} until the end of the road.', 'This is a {{test}} of patience.'] },
    },
    // Changed an hour ago, so its new example isn't due yet.
    { type: 'vocab', savedAt: now - 400 * HOUR, updatedAt: now - HOUR, data: { id: 'edited', examples: ['A brand new {{sentence}} here.'] } },
    // Saved an hour ago with its own analysis: the old card's first example no longer needs one.
    {
      type: 'sentence',
      savedAt: now - HOUR,
      data: {
        id: 'saved',
        text: 'Keep going until the end of the road.',
        analysis: completeAnalysis,
        analysisGeneratedAt: now - 3 * HOUR,
        imageUrl: 'server:has_image',
      },
    },
  ];

  const stall = findStalledEnrichment(items, () => [], { overdueAfterHours: 18, imageGapTolerance: 20, now });

  assert.equal(stall.textGaps, 1);
  assert.equal(stall.imageGaps, 1);
  assert.equal(stall.lastLocalEnrichmentAt, now - 3 * HOUR);
});

test('the stall check alerts once overdue images outnumber the deferral allowance', () => {
  const items = ['a', 'b', 'c'].map(id => ({
    type: 'vocab',
    savedAt: now - 400 * HOUR,
    data: { id, word: id, imagePrompt: 'A photorealistic picture of the word on a sign.' },
  }));
  const check = (imageGapTolerance: number) =>
    findStalledEnrichment(items, () => [], { overdueAfterHours: 18, imageGapTolerance, now }).alerts;

  assert.deepEqual(check(3), []);
  assert.deepEqual(check(2), [
    '3 images have been due for over 18 h, more than the 2 that deferred subjects explain (it has never published)',
  ]);
});
