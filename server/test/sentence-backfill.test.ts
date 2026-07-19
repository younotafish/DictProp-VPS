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
