import assert from 'node:assert/strict';
import test from 'node:test';
import { corpusAuditDataState, corpusSourceHash, validateCorpusAuditBundle } from '../src/corpus-audit.js';

const audit = { status: 'modern_american', reason: 'Common in present-day American English.', confidence: 'high', auditedAt: 1 };
const data = {
  id: 'word-1', word: 'check', chinese: '检查', ipa: '/tʃek/', definition: 'to examine',
  synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '', usageAudit: audit,
};
const bundle = {
  version: 1,
  generatedAt: 1,
  model: 'gpt-5.6-sol',
  entries: [{ id: 'word-1', type: 'vocab', sourceHash: corpusSourceHash(data), data, wasArchived: false, archiveForUsage: false }],
};

test('corpus hashes ignore image storage markers', () => {
  assert.equal(corpusSourceHash({ ...data, imageUrl: 'server:has_image' }), corpusSourceHash({ ...data, imageUrl: 'data:image/png;base64,AAA=' }));
});

test('corpus audit bundle requires complete and consistent decisions', () => {
  assert.equal(validateCorpusAuditBundle(bundle), null);
  assert.match(validateCorpusAuditBundle({ ...bundle, entries: [{ ...bundle.entries[0], archiveForUsage: true }] }) || '', /disagrees/);
  assert.match(validateCorpusAuditBundle({ ...bundle, entries: [{ ...bundle.entries[0], data: { ...data, usageAudit: undefined } }] }) || '', /complete/);
});

test('corpus audit imports can resume after a partial run', () => {
  const original = { ...data, usageAudit: undefined };
  const entry = { sourceHash: corpusSourceHash(original), data };
  assert.equal(corpusAuditDataState(original, entry), 'source');
  assert.equal(corpusAuditDataState({ ...data, imageUrl: 'server:has_image' }, entry), 'target');
  assert.equal(corpusAuditDataState({ ...original, definition: 'changed after export' }, entry), 'changed');
});
