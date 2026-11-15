import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { markLocalAdvancedEnrichment } from '../../scripts/offline/local-advanced-enrichment.mjs';
import { corpusSourceHash } from '../src/corpus-audit.js';
import { USAGE_STATUSES, shouldArchiveUsage, type UsageAudit } from '../src/usage-audit.js';
import { repoPath } from './support/paths.js';

const script = repoPath('scripts', 'offline', 'prepare-incremental-vocab-source.mjs');
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A card every field check accepts; it lacks only the local advanced rewrite. */
const card = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  word: 'sample',
  sense: 'noun: an illustrative instance',
  chinese: '例子',
  ipa: '/ˈsæmpəl/',
  definition: 'One item used to illustrate a larger group or idea.',
  forms: ['sample', 'samples'],
  wordFamily: [{ word: 'sampling', pos: 'noun', chinese: '抽样' }],
  history: 'From Old French essample, ultimately from Latin exemplum.',
  register: 'Common in present-day American English.',
  mnemonic: 'A sample lets you see a small part of the whole.',
  imagePrompt: 'A photorealistic close view of one sample jar selected from a larger organized collection.',
  synonyms: ['example'],
  antonyms: [],
  confusables: [],
  examples: [
    'She brought a {{sample}} home before choosing the paint color.',
    'The lab tested a {{sample}} from each shipment.',
  ],
  usageAudit: { status: 'current_general', reason: 'This is current general English.', confidence: 'high', auditedAt: 1 },
  ...overrides,
});

interface Entry { id: string; type: string; wasArchived: boolean; archiveForUsage: boolean; data: { usageAudit?: UsageAudit } }

function prepare(items: Array<Record<string, unknown>>, args: string[] = ['100', '168']) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-vocab-source-'));
  const corpusPath = join(root, 'corpus.json');
  const outputPath = join(root, 'source.json');
  writeFileSync(corpusPath, JSON.stringify({
    version: 1,
    items: items.map(item => ({ ...item, sourceHash: corpusSourceHash(item.data) })),
  }));
  const child = spawnSync(process.execPath, [script, corpusPath, outputPath, ...args], { encoding: 'utf8' });
  return {
    status: child.status,
    stderr: child.stderr,
    summary: child.status === 0 ? JSON.parse(child.stdout) : null,
    output: child.status === 0 ? JSON.parse(readFileSync(outputPath, 'utf8')) : null,
  };
}

test('the vocabulary source counts each card it leaves out under the reason it was left out', () => {
  const now = Date.now();
  const old = now - 30 * DAY_MS;
  const items = [
    { type: 'vocab', savedAt: now, data: card('recent-basic') },
    { type: 'vocab', savedAt: now, data: markLocalAdvancedEnrichment(card('recent-advanced'), 'model') },
    { type: 'vocab', savedAt: old, data: card('old-critical', { ipa: '' }) },
    { type: 'vocab', savedAt: old, data: card('old-examples-only', { examples: ['Too short.'] }) },
    { type: 'vocab', savedAt: old, data: card('old-advanced-only') },
    { type: 'vocab', savedAt: now, data: card('no-headword', { word: '' }) },
    {
      type: 'phrase',
      savedAt: now,
      data: { id: 'unaudited-phrase', query: 'call off', vocabs: [card('unaudited-phrase-card', { ipa: '' })] },
    },
    {
      type: 'phrase',
      savedAt: now,
      data: {
        id: 'audited-phrase',
        query: 'give up',
        usageAudit: { status: 'current_general', reason: 'Common.', confidence: 'high', auditedAt: 1 },
        vocabs: [card('audited-phrase-card', { ipa: '' })],
      },
    },
    { type: 'vocab', savedAt: now, wasArchived: true, data: card('archived') },
    { type: 'vocab', savedAt: now, isDeleted: true, data: card('deleted') },
    { type: 'sentence', savedAt: now, data: { id: 'sentence', text: 'A saved sentence.' } },
  ];

  const result = prepare(items);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output.entries.map((entry: Entry) => entry.id), [
    'audited-phrase', 'recent-basic', 'old-critical',
  ]);
  assert.deepEqual(
    {
      eligible: result.summary.eligible,
      selected: result.summary.selected,
      ignoredOlderNonCritical: result.summary.ignoredOlderNonCritical,
      missingHeadword: result.summary.missingHeadword,
      unauditedPhrases: result.summary.unauditedPhrases,
      deferred: result.summary.deferred,
    },
    { eligible: 3, selected: 3, ignoredOlderNonCritical: 2, missingHeadword: 1, unauditedPhrases: 1, deferred: 0 },
  );
  assert.deepEqual(Object.keys(result.output), ['version', 'generatedAt', 'model', 'entries']);
  for (const entry of result.output.entries as Entry[]) assert.equal(entry.wasArchived, false);
});

test('the vocabulary source marks a card for archiving exactly when the server would archive it', () => {
  const now = Date.now();
  const confidences: Array<UsageAudit['confidence']> = ['high', 'medium', 'low'];
  const items = USAGE_STATUSES.flatMap((status, statusIndex) => confidences.map((confidence, confidenceIndex) => ({
    type: 'vocab',
    savedAt: now + statusIndex * 3 + confidenceIndex,
    data: card(`${status}-${confidence}`, { usageAudit: { status, reason: 'Audited.', confidence, auditedAt: 1 } }),
  })));

  const result = prepare(items);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.entries.length, USAGE_STATUSES.length * confidences.length);
  for (const entry of result.output.entries as Entry[]) {
    const audit = entry.data.usageAudit as UsageAudit;
    assert.equal(entry.archiveForUsage, shouldArchiveUsage(audit.status, audit.confidence), entry.id);
  }
});
