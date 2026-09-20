import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { corpusSourceHash } from '../src/corpus-audit.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = (name: string) => join(repoRoot, 'scripts', 'offline', name);
const completeAudit = {
  status: 'current_general',
  reason: 'This is current general English.',
  confidence: 'high',
  auditedAt: 1,
};
const completeCard = (id: string) => ({
  id,
  word: 'sample',
  sense: 'noun: an illustrative instance',
  chinese: '例子',
  ipa: '/ˈsæmpəl/',
  definition: 'One item used to illustrate a larger group or idea.',
  forms: ['sample', 'samples'],
  wordFamily: [],
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
  usageAudit: completeAudit,
});

test('incremental item image preparation emits only missing image records with import-safe hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-item-images-'));
  const corpusPath = join(root, 'corpus.json');
  const analysisPath = join(root, 'analysis.json');
  const outputRoot = join(root, 'output');
  const items = [
    {
      type: 'vocab', savedAt: 1, isArchived: false,
      data: { ...completeCard('missing-word'), imageUrl: undefined },
    },
    {
      type: 'vocab', savedAt: 2, isArchived: false,
      data: { ...completeCard('covered-word'), imageUrl: 'server:has_image:v1' },
    },
    {
      type: 'sentence', savedAt: 3, isArchived: false,
      data: { id: 'sentence', text: 'A sample is ready.', sourceWord: 'sample' },
    },
  ];
  writeFileSync(corpusPath, JSON.stringify({ version: 1, exportedAt: Date.now(), items }));
  writeFileSync(analysisPath, JSON.stringify({
    version: 1,
    entries: [{ id: 'sentence', analysis: { imagePrompt: 'A realistic photograph of a prepared sample on a clean workbench.' } }],
  }));

  execFileSync(process.execPath, [
    script('prepare-incremental-item-images.mjs'), corpusPath, analysisPath, '-', outputRoot,
  ]);
  const manifest = JSON.parse(readFileSync(join(outputRoot, 'manifest.json'), 'utf8'));
  const targets = JSON.parse(readFileSync(join(outputRoot, 'targets.json'), 'utf8'));

  assert.deepEqual(targets.targets.map((target: any) => target.imageId), ['missing-word', 'sentence']);
  assert.equal(manifest.entries[0].parentHash, corpusSourceHash(items[0].data));
  assert.equal(manifest.entries[1].parentHash, corpusSourceHash(items[2].data));
});

test('incremental vocabulary preparation repairs recent cards and critical legacy gaps only', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-vocab-source-'));
  const corpusPath = join(root, 'corpus.json');
  const outputPath = join(root, 'source.json');
  const now = Date.now();
  const old = now - 30 * 24 * 60 * 60 * 1_000;
  const legacyExampleOnly = { ...completeCard('legacy-example'), examples: ['Legacy unmarked example.'] };
  const legacyCritical = { ...completeCard('legacy-critical'), ipa: '' };
  const recentExampleOnly = { ...completeCard('recent-example'), examples: ['Recent unmarked example.'] };
  const items = [
    { type: 'vocab', savedAt: old, data: legacyExampleOnly, sourceHash: corpusSourceHash(legacyExampleOnly) },
    { type: 'vocab', savedAt: old + 1, data: legacyCritical, sourceHash: corpusSourceHash(legacyCritical) },
    { type: 'vocab', savedAt: now, data: recentExampleOnly, sourceHash: corpusSourceHash(recentExampleOnly) },
  ];
  writeFileSync(corpusPath, JSON.stringify({ version: 1, exportedAt: now, items }));

  execFileSync(process.execPath, [
    script('prepare-incremental-vocab-source.mjs'), corpusPath, outputPath, '10', '168',
  ]);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));

  assert.deepEqual(output.entries.map((entry: any) => entry.id), ['recent-example', 'legacy-critical']);
});
