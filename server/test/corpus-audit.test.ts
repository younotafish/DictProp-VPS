import assert from 'node:assert/strict';
import test from 'node:test';
import {
  corpusAuditDataState,
  corpusAuditImportState,
  corpusSourceHash,
  validateCorpusAuditBundle,
} from '../src/corpus-audit.js';
import { resolveUsageArchive } from '../src/usage-audit.js';

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

test('corpus hashes ignore later sentence analysis enrichment', () => {
  const sentence = { id: 'sentence-1', text: 'He came clean.', sourceWord: 'come clean', usageAudit: audit };
  const first = {
    ...sentence,
    analysis: { translation: '他坦白了。', naturalSpeechIpa: '/hi keɪm kliːn/' },
    analysisGeneratedAt: 10,
  };
  const later = {
    ...sentence,
    analysis: { translation: '他终于坦白了。', naturalSpeechIpa: '/hi keɪm kliːn/' },
    analysisGeneratedAt: 20,
  };
  assert.equal(corpusSourceHash(first), corpusSourceHash(later));
  assert.equal(corpusAuditDataState(later, { sourceHash: corpusSourceHash(first), data: first }), 'target');
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

test('corpus audit imports repair usage archive drift after metadata is already applied', () => {
  const rareAudit = { ...audit, status: 'rare_or_dated' as const };
  const rareData = { ...data, usageAudit: rareAudit };
  const entry = { sourceHash: corpusSourceHash(data), data: rareData };

  assert.deepEqual(corpusAuditImportState(rareData, false, entry), {
    dataState: 'target',
    nextArchived: true,
    alreadyApplied: false,
  });
  assert.deepEqual(corpusAuditImportState(rareData, true, entry), {
    dataState: 'target',
    nextArchived: true,
    alreadyApplied: true,
  });
});

test('usage re-audits reverse only prior usage-driven archives', () => {
  const rareAudit = { ...audit, status: 'rare_or_dated' as const };
  assert.equal(resolveUsageArchive(true, rareAudit, audit), false, 'corrected prior auto-archive');
  assert.equal(resolveUsageArchive(true, audit, audit), true, 'preserved manual archive');
  assert.equal(resolveUsageArchive(false, audit, rareAudit), true, 'applied new low-value archive');
});
