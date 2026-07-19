import assert from 'node:assert/strict';
import test from 'node:test';
import { sortStoredSensesByUsage, sortVocabCardsByUsage } from '../../services/usageAudit.ts';
import type { StoredItem, UsageStatus, VocabCard } from '../../types.ts';

const card = (word: string, status?: UsageStatus): VocabCard => ({
  id: `${word}-${status || 'none'}`,
  word,
  sense: status,
  chinese: '',
  ipa: '',
  definition: word,
  synonyms: [],
  antonyms: [],
  confusables: [],
  examples: [],
  history: '',
  register: '',
  mnemonic: '',
  ...(status ? { usageAudit: { status, reason: status, confidence: 'high', auditedAt: 1 } } : {}),
});

const stored = (data: VocabCard): StoredItem => ({
  data,
  type: 'vocab',
  savedAt: 1,
  srs: {
    id: data.id,
    type: 'vocab',
    nextReview: 0,
    interval: 0,
    memoryStrength: 0,
    lastReviewDate: 0,
    totalReviews: 0,
    correctStreak: 0,
    stability: 0,
  },
});

test('live and saved senses put useful modern usage before specialized, British, and rare meanings', () => {
  const cards = [
    card('word', 'rare_or_dated'),
    card('word', 'british_only'),
    card('word', 'current_general'),
    card('word', 'narrow_specialized'),
    card('word', 'modern_american'),
  ];
  const expected = ['modern_american', 'current_general', 'narrow_specialized', 'british_only', 'rare_or_dated'];
  assert.deepEqual(sortVocabCardsByUsage(cards).map(value => value.usageAudit?.status), expected);
  assert.deepEqual(sortStoredSensesByUsage(cards.map(stored)).map(value => (value.data as VocabCard).usageAudit?.status), expected);
});
