import assert from 'node:assert/strict';
import test from 'node:test';
import { contentHash, parentHash, sentenceHash } from '../../scripts/offline/failure-ledger.mjs';
import { corpusSourceHash as corpusAuditSourceHash } from '../../server/src/corpus-audit.ts';
import { corpusSourceHash } from '../../server/src/corpus-hash.ts';
import { advancedVocabContentHash, imagePromptHash } from '../../server/src/local-enrichment-markers.ts';
import { sha256 } from '../support/fs.ts';

// The offline scripts and the server share their contracts through server modules the scripts load under plain node.
// The cycle keys what it records by hashes those modules compute: the failure ledger its entries, every bundle it
// publishes its entries' sourceHash, the enrichment markers their content and prompt hashes. A changed value would
// make every recorded failure look like a new item and every published entry look edited since its export, so the
// values below, taken before the hashing code moved into those modules, pin them.

// A phrase with a sentence's server-written fields, carrying an imageUrl at every depth the hashes strip it from.
const item = {
  id: 'pin-phrase',
  query: 'give up',
  imageUrl: 'server:has_image:v3',
  analysis: { imageUrl: 'data:image/png;base64,AA', translation: '放弃' },
  analysisGeneratedAt: 7,
  preferredSpeechStyle: 'casual',
  vocabs: [
    {
      id: 'pin-give-up', word: 'give up', imageUrl: 'idb:stored', synonyms: ['quit'],
      advancedEnrichment: { version: 1, provider: 'claude-code', model: 'm', generatedAt: 2, contentHash: 'x' },
    },
    { id: 'pin-give', word: 'give', imageUrl: null, examples: ['They {{give}} back.', 'We [[always]] {{give}} more.'] },
  ],
};

test('the failure ledger keys an item by the same hash as before', () => {
  const ledgerHash = '1ede8b8d5d7c6dfb6718d28b62103cf53133d3a12ee6b7b94d1c79faa8e72c9f';
  assert.equal(contentHash(item), ledgerHash);
  assert.equal(parentHash({ data: item }), ledgerHash);
  assert.equal(parentHash({ sourceHash: 'recorded', data: item }), 'recorded');
  assert.equal(contentHash(undefined), sha256('null'));
  assert.equal(sentenceHash({ id: 's', text: 'x', imageUrl: 'y' }), 'f070aa3ecddf4c284dfd514153c99b661b83f98db420237da67381305efa3649');
  // It ignores images at any depth, and keeps what the server writes into a saved sentence.
  assert.equal(contentHash({ ...item, imageUrl: 'server:has_image:v4', vocabs: item.vocabs.map(card => ({ ...card, imageUrl: 'x' })) }), ledgerHash);
  assert.notEqual(contentHash({ ...item, analysisGeneratedAt: 8 }), ledgerHash);
});

test('the corpus source hash keeps its value, wherever it is imported from', () => {
  const sourceHash = 'e29f3bd0ec34a64aad34f412ae032f44e5df7e37d1be7251887f2f16a403b997';
  assert.equal(corpusSourceHash(item), sourceHash);
  assert.equal(corpusAuditSourceHash, corpusSourceHash);
  // It ignores images at any depth, and what the server writes into a saved sentence.
  assert.equal(corpusSourceHash({ ...item, imageUrl: 'server:has_image:v4', analysisGeneratedAt: 8, preferredSpeechStyle: 'clear' }), sourceHash);
  assert.notEqual(corpusSourceHash({ ...item, query: 'give in' }), sourceHash);
});

test('the enrichment markers hash a card and a prompt as before', () => {
  assert.equal(advancedVocabContentHash(item.vocabs[0]), '50e70a1d0bd3d0eebbd98179c7a8bd330ace563254adbb1287c1a1111b640762');
  assert.equal(imagePromptHash('  A photograph of a runner stopping.  '), '67cc18e12fbfbd662132c3fba6c2402576c50f237c0f0f2fce9970e5551cc1bd');
});
