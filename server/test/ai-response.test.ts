import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidUsageAudit,
  normalizeAnalysisResponse,
  normalizeVocabCard,
} from '../src/ai-response.js';

const completeCard = (overrides: Record<string, unknown> = {}) => ({
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A financial institution.',
  forms: ['bank', 'banks'],
  wordFamily: [],
  synonyms: ['financial institution'],
  antonyms: [],
  confusables: [],
  examples: ['I stopped by the {{bank}} after work.'],
  history: 'From Old Norse banki.',
  register: 'Common, current general English.',
  mnemonic: 'Money bank.',
  imagePrompt: 'A neighborhood bank.',
  ...overrides,
});

test('normalization repairs optional model fields instead of rejecting the whole search', () => {
  const normalized = normalizeVocabCard(completeCard({
    forms: null,
    synonyms: 'lender',
    antonyms: undefined,
    confusables: [{ sentence: 'bank/bankroll' }],
    imagePrompt: null,
    usageAudit: undefined,
  }), 'bank', 1234);

  assert.ok(normalized);
  assert.deepEqual(normalized.forms, []);
  assert.deepEqual(normalized.synonyms, ['lender']);
  assert.deepEqual(normalized.antonyms, []);
  assert.deepEqual(normalized.confusables, ['bank/bankroll']);
  assert.equal(normalized.imagePrompt, '');
  assert.deepEqual(normalized.usageAudit, {
    status: 'current_general',
    reason: 'Automatically classified from the register note: Common, current general English.',
    confidence: 'low',
    auditedAt: 1234,
  });
});

test('normalization keeps usable siblings, drops unusable cards, and orders senses by learner value', () => {
  const result = normalizeAnalysisResponse({
    query: 'bank',
    vocabs: [
      completeCard({
        sense: 'obsolete meaning',
        usageAudit: { status: 'rare_or_dated', reason: 'Obsolete.', confidence: 'high' },
      }),
      { word: 'bank', chinese: '坏数据' },
      completeCard({
        sense: 'common meaning',
        usageAudit: { status: 'modern_american', reason: 'Common in the US.', confidence: 'high' },
      }),
      completeCard({
        sense: 'British meaning',
        usageAudit: { status: 'British only', reason: 'Use the US equivalent instead.', confidence: 'medium' },
      }),
    ],
  }, { fallbackQuery: 'bank', auditedAt: 5678 });

  assert.equal(result.inputCards, 4);
  assert.equal(result.droppedCards, 1);
  assert.deepEqual(result.data.vocabs.map((vocab: any) => vocab.sense), [
    'common meaning',
    'British meaning',
    'obsolete meaning',
  ]);
  assert.ok(result.data.vocabs.every((vocab: any) => isValidUsageAudit(vocab.usageAudit)));
  assert.ok(result.data.vocabs.every((vocab: any) => vocab.usageAudit.auditedAt === 5678));
});

test('normalization accepts common model aliases for essential fields', () => {
  const result = normalizeAnalysisResponse({
    query: '',
    vocab: {
      term: 'wind down',
      meaning: 'To gradually relax or reduce activity.',
      translation: '逐渐放松；逐步结束',
      pronunciation: '/waɪnd daʊn/',
      usageExamples: 'I need an hour to {{wind down}} after work.',
      usage: { label: 'current general', explanation: 'Common in everyday speech.', confidence: 'high' },
    },
  }, { fallbackQuery: 'wind down', auditedAt: 999 });

  assert.equal(result.data.query, 'wind down');
  assert.equal(result.data.vocabs.length, 1);
  assert.equal(result.data.vocabs[0].word, 'wind down');
  assert.deepEqual(result.data.vocabs[0].examples, ['I need an hour to {{wind down}} after work.']);
  assert.equal(result.data.vocabs[0].usageAudit.status, 'current_general');
});
