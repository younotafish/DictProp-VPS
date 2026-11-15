import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSavedVocabByBase, pickSavedItem, savedCardsForBases } from '../../services/notebook/libraryLookups.ts';
import type { StoredItem, UsageStatus, VocabCard } from '../../types.ts';

const vocab = (word: string, { sense = '', status, reviews = 0 }: { sense?: string; status?: UsageStatus; reviews?: number } = {}): StoredItem => {
  const id = `${word}:${sense}:${status ?? ''}:${reviews}`;
  const data: VocabCard = {
    id, word, sense, chinese: '', ipa: '', definition: word, synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
    ...(status ? { usageAudit: { status, reason: status, confidence: 'high' as const, auditedAt: 1 } } : {}),
  };
  return {
    data, type: 'vocab', savedAt: 1,
    srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: reviews, correctStreak: 0, stability: 0 },
  };
};

test('each base word keeps its most useful card: usage status first, then the most reviews, then the first saved', () => {
  const rare = vocab('bank', { sense: 'tilt', status: 'rare_or_dated', reviews: 9 });
  const modern = vocab('bank', { sense: 'money', status: 'modern_american', reviews: 1 });
  const modernReviewed = vocab('Bank', { sense: 'deposit', status: 'modern_american', reviews: 4 });
  const modernTie = vocab('bank', { sense: 'teller', status: 'modern_american', reviews: 4 });
  const unaudited = vocab('river', { reviews: 2 });
  const general = vocab('river', { sense: 'flow', status: 'current_general', reviews: 1 });
  const phrase: StoredItem = { ...vocab('bank on it'), type: 'phrase' };

  const byBase = buildSavedVocabByBase([rare, modern, modernReviewed, modernTie, unaudited, general, phrase]);
  assert.equal(byBase.get('bank'), modernReviewed);
  // An unaudited card ranks as current_general, so the review count decides between them.
  assert.equal(byBase.get('river'), unaudited);
  assert.equal(byBase.has('bank on it'), false);
});

test('a term matching several base words takes the most reviewed card, the first base winning a tie', () => {
  const run = vocab('run', { reviews: 3 });
  const running = vocab('running', { reviews: 7 });
  const ran = vocab('ran', { reviews: 7 });
  const byBase = new Map([['run', run], ['running', running], ['ran', ran]]);
  assert.equal(pickSavedItem(['run', 'running', 'ran'], byBase), running);
  assert.equal(pickSavedItem(['ran', 'running'], byBase), ran);
  assert.equal(pickSavedItem(['walk'], byBase), null);
  assert.equal(pickSavedItem([], byBase), null);
});

test('the saved cards for a word are every sense under its base words, normalized as the index is, most useful first', () => {
  const items = [
    vocab('Don’t', { sense: 'contraction', status: 'rare_or_dated' }),
    vocab("don't", { sense: 'imperative', status: 'modern_american' }),
    vocab('do', { sense: 'verb' }),
    { ...vocab("don't", { sense: 'phrase' }), type: 'phrase' as const },
  ];
  assert.deepEqual(
    savedCardsForBases(new Set(["don't"]), items).map(card => card.sense),
    ['imperative', 'contraction'],
  );
  assert.deepEqual(savedCardsForBases(new Set(['missing']), items), []);
});
