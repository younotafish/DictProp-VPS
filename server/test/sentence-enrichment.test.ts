import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  normalizeSentenceLookup,
  sentenceLookupHash,
  validateSentenceEnrichmentBundle,
} from '../src/sentence-enrichment.js';

const text = 'She finally [[came clean]] about the mistake.';
const lookupHash = sentenceLookupHash(text);
const entry = {
  id: `example-${lookupHash.slice(0, 40)}`,
  text,
  lookupHash,
  textHash: createHash('sha256').update(text).digest('hex'),
  analysis: {
    translation: '她终于坦白了那个错误。',
    naturalSpeechIpa: '/ʃi ˈfaɪnəli keɪm kliːn əˈbaʊt ðə mɪˈsteɪk/',
    americanEnglish: { status: 'shared', explanation: 'This is natural in American English.' },
    terms: [],
    imagePrompt: 'A realistic photograph of a candid conversation in a kitchen, without text.',
  },
  generatedAt: 1,
  imageFile: 'images/example.webp',
};

test('sentence enrichment identity ignores learning markup and typographic punctuation', () => {
  assert.equal(normalizeSentenceLookup(text), 'she finally came clean about the mistake.');
  assert.equal(
    sentenceLookupHash('She finally {{came clean}} about the mistake.'),
    sentenceLookupHash('She finally [[came clean]] about the mistake.'),
  );
  assert.equal(
    normalizeSentenceLookup('He said \u201cI\u2019m ready\u201d \u2014 calmly.'),
    'he said "i\'m ready" - calmly.',
  );
});

test('sentence enrichment bundles bind text, lookup identity, analysis, and safe image paths', () => {
  const bundle = { version: 1, generatedAt: 1, entries: [entry] };
  assert.equal(validateSentenceEnrichmentBundle(bundle), null);
  assert.match(validateSentenceEnrichmentBundle({
    ...bundle,
    entries: [{ ...entry, lookupHash: 'a'.repeat(64) }],
  }) || '', /does not match text/);
  assert.match(validateSentenceEnrichmentBundle({
    ...bundle,
    entries: [{ ...entry, textHash: 'b'.repeat(64) }],
  }) || '', /textHash/);
  assert.match(validateSentenceEnrichmentBundle({
    ...bundle,
    entries: [{ ...entry, imageFile: '../dictprop.db' }],
  }) || '', /imageFile/);
  assert.match(validateSentenceEnrichmentBundle({
    ...bundle,
    entries: [entry, entry],
  }) || '', /duplicates id/);
});

test('analysis-only enrichment waves can be larger than image-bearing waves', () => {
  const entries = Array.from({ length: 501 }, (_, index) => {
    const itemText = `A distinct sentence number ${index} is ready for analysis.`;
    const itemLookupHash = sentenceLookupHash(itemText);
    return {
      ...entry,
      id: `example-${itemLookupHash.slice(0, 40)}`,
      text: itemText,
      lookupHash: itemLookupHash,
      textHash: createHash('sha256').update(itemText).digest('hex'),
      imageFile: undefined,
    };
  });
  assert.equal(validateSentenceEnrichmentBundle({ version: 1, generatedAt: 1, entries }), null);
  assert.match(validateSentenceEnrichmentBundle({
    version: 1,
    generatedAt: 1,
    entries: entries.map(value => ({ ...value, imageFile: 'images/example.webp' })),
  }) || '', /at most 500/);
});
