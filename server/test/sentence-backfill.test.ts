import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSentenceBackfillBundle } from '../src/sentence-backfill.js';

const analysis = {
  translation: '他终于坦白了。',
  naturalSpeechIpa: '/hi ˈfaɪnəli keɪm kliːn/',
  americanEnglish: { status: 'shared', explanation: 'This wording is shared across major varieties.' },
  terms: [],
  imagePrompt: 'A photorealistic wide image of a candid conversation in a kitchen, no visible text.',
};

const bundle = {
  version: 1,
  generatedAt: 1,
  entries: [{
    id: 'sentence-1',
    textHash: 'a'.repeat(64),
    analysis,
    generatedAt: 1,
    imageFile: 'images/sentence-1.png',
  }],
};

test('sentence backfill bundle validates identities, hashes, analysis, and safe image paths', () => {
  assert.equal(validateSentenceBackfillBundle(bundle), null);
  assert.match(validateSentenceBackfillBundle({
    ...bundle,
    entries: [bundle.entries[0], bundle.entries[0]],
  }) || '', /duplicates id/);
  assert.match(validateSentenceBackfillBundle({
    ...bundle,
    entries: [{ ...bundle.entries[0], textHash: 'short' }],
  }) || '', /textHash/);
  assert.match(validateSentenceBackfillBundle({
    ...bundle,
    entries: [{ ...bundle.entries[0], imageFile: '../dictprop.db' }],
  }) || '', /imageFile/);
  assert.match(validateSentenceBackfillBundle({
    ...bundle,
    entries: [{ ...bundle.entries[0], imageFile: undefined, replaceImage: true }],
  }) || '', /without imageFile/);
});

test('a bundle or entry that is not an object, a bad time or a bad hash each get their own refusal', () => {
  const withEntry = (changes: object) => validateSentenceBackfillBundle({ ...bundle, entries: [{ ...bundle.entries[0], ...changes }] });
  for (const value of [null, [bundle], 'bundle']) assert.equal(validateSentenceBackfillBundle(value), 'bundle must be an object');
  for (const generatedAt of [0, -1, Number.NaN, Infinity, '1']) {
    assert.equal(validateSentenceBackfillBundle({ ...bundle, generatedAt }), 'bundle generatedAt is invalid');
    assert.equal(withEntry({ generatedAt }), 'entry 0 generatedAt is invalid');
  }
  assert.equal(validateSentenceBackfillBundle({ ...bundle, entries: [null] }), 'entry 0 must be an object');
  for (const textHash of ['A'.repeat(64), 'a'.repeat(65), 64]) assert.equal(withEntry({ textHash }), 'entry 0 textHash is invalid');
});
