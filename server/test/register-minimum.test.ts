import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVocabCard, REGISTER_MINIMUM, vocabValidationIssues } from '../src/ai-response.js';

// The local cycle's definition of a complete stored card.
const { missingCardFields } = await import(new URL('../../scripts/offline/vocab-card-contract.mjs', import.meta.url).href);

const raw = (register: string) => ({
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A business that keeps and lends money.',
  forms: ['bank', 'banks'],
  wordFamily: [{ word: 'banker', pos: 'noun', chinese: '银行家' }],
  synonyms: ['lender'],
  antonyms: [],
  confusables: ['bench'],
  examples: [
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} approved our mortgage sooner than I expected.',
  ],
  history: 'From Italian banca, the bench where money changers worked.',
  register,
  mnemonic: 'A bench (banca) where the money sat.',
  imagePrompt: 'A realistic neighborhood bank counter with a customer depositing a paycheck, natural daylight.',
  usageAudit: { status: 'current_general', reason: 'Normal in American English.', confidence: 'high' },
});
const card = normalizeVocabCard(raw('Neutral; fine in speech and writing.'), 'bank', 1234);

// The shortest register note a check accepts, found by trying every length.
const shortestAccepted = (accepts: (register: string) => boolean): number => {
  for (let length = 1; length <= 40; length++) if (accepts('r'.repeat(length))) return length;
  return Infinity;
};

test('the server keeps the same register minimum as the local cycle\'s card contract', () => {
  assert.deepEqual(missingCardFields(card), []);
  assert.deepEqual(vocabValidationIssues(card), []);

  const contractMinimum = shortestAccepted(register => !missingCardFields({ ...card, register }).includes('register'));
  const serverMinimum = shortestAccepted(register => vocabValidationIssues({ ...card, register }).length === 0);
  assert.equal(contractMinimum, 10);
  assert.equal(serverMinimum, contractMinimum);
  assert.equal(REGISTER_MINIMUM, contractMinimum);
});

test('a live card keeps a full register note and drops a shorter label instead of failing', () => {
  const short = 'r'.repeat(REGISTER_MINIMUM - 1);
  const full = 'r'.repeat(REGISTER_MINIMUM);
  assert.equal(normalizeVocabCard(raw(short), 'bank', 1234).register, '');
  assert.equal(normalizeVocabCard(raw(`  ${short}  `), 'bank', 1234).register, '');
  assert.equal(normalizeVocabCard(raw(full), 'bank', 1234).register, full);

  const dropped = normalizeVocabCard(raw('formal'), 'bank', 1234);
  assert.deepEqual(vocabValidationIssues(dropped, { optionalRegister: true }), []);
  // The stored corpus still counts the note as missing, so the local cycle writes one.
  assert.deepEqual(missingCardFields(dropped), ['register']);
});
