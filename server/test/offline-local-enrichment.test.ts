import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { corpusSourceHash } from '../src/corpus-audit.js';
import { hasCurrentLocalAdvancedEnrichment } from '../src/incremental-enrichment.js';

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
const canonicalize = (value: any): any => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value;
const locallyEnriched = (card: any) => {
  const content = Object.fromEntries(Object.entries(card)
    .filter(([key]) => key !== 'imageUrl' && key !== 'advancedEnrichment' && key !== 'localImageEnrichment'));
  const contentHash = createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
  return {
    ...card,
    advancedEnrichment: {
      version: 1,
      provider: 'codex-harness',
      model: 'gpt-5.6-sol',
      generatedAt: 1,
      contentHash,
    },
  };
};
const locallyImaged = (card: any) => ({
  ...card,
  localImageEnrichment: {
    version: 1,
    provider: 'local-ernie',
    model: 'local-test-image-model',
    generatedAt: 1,
    promptHash: createHash('sha256').update(String(card.imagePrompt || '').trim()).digest('hex'),
  },
});

const fakeCodex = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const marker = 'COMPLETE THESE CARDS:\\n';
  const start = prompt.lastIndexOf(marker) + marker.length;
  const items = JSON.parse(prompt.slice(start));
  const results = items.map(item => ({
    itemIndex: item.itemIndex,
    sense: item.sense,
    chinese: 'Codex高级版本',
    ipa: '/ˈsæmpəl/',
    definition: 'A Codex-generated advanced definition for this exact sense.',
    forms: ['sample', 'samples'],
    wordFamily: [{ word: 'sampling', pos: 'noun', chinese: '抽样' }],
    synonyms: ['example'],
    antonyms: [],
    confusables: ['simple'],
    examples: [
      'I tested a {{sample}} before ordering the full batch.',
      'The lab kept a {{sample}} from every shipment.',
    ],
    history: 'The word developed through Old French from Latin exemplum, meaning an example.',
    register: 'Common in present-day American English across everyday and technical settings.',
    mnemonic: 'A sample is a small example of the whole.',
    imagePrompt: 'A realistic close photograph of one sample jar beside a larger organized collection, natural light, no text.',
    usageAudit: {
      status: 'current_general',
      reason: 'This exact sense is common in modern American English.',
      confidence: 'high',
    },
  }));
  const outputIndex = process.argv.indexOf('-o');
  writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ results }));
});
`;

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
      type: 'vocab', savedAt: 2.5, isArchived: false,
      data: locallyImaged(locallyEnriched({
        ...completeCard('locally-covered-word'), imageUrl: 'server:has_image:v1',
      })),
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
  assert.equal(manifest.entries[1].parentHash, corpusSourceHash(items[3].data));
  assert.equal(
    manifest.entries[0].promptHash,
    createHash('sha256').update(items[0].data.imagePrompt.trim()).digest('hex'),
  );
});

test('a local advanced rewrite replaces an existing server-generated image', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-local-image-refresh-'));
  const corpusPath = join(root, 'corpus.json');
  const completionPath = join(root, 'completion.json');
  const outputRoot = join(root, 'output');
  const basic = { ...completeCard('rewrite-image'), imageUrl: 'server:has_image:v1' };
  const advanced = locallyEnriched({
    ...basic,
    definition: 'A more precise locally generated definition for this exact sense.',
    imagePrompt: 'A photorealistic close view of a carefully selected sample jar beside the full batch, no text.',
  });
  writeFileSync(corpusPath, JSON.stringify({
    version: 1,
    items: [{ type: 'vocab', savedAt: Date.now(), data: basic, sourceHash: corpusSourceHash(basic) }],
  }));
  writeFileSync(completionPath, JSON.stringify({
    version: 1,
    entries: [{
      id: basic.id,
      type: 'vocab',
      sourceHash: corpusSourceHash(basic),
      wasArchived: false,
      archiveForUsage: false,
      data: advanced,
    }],
  }));

  execFileSync(process.execPath, [
    script('prepare-incremental-item-images.mjs'), corpusPath, '-', completionPath, outputRoot,
  ]);
  const targets = JSON.parse(readFileSync(join(outputRoot, 'targets.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(outputRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(targets.targets.map((target: any) => target.imageId), [basic.id]);
  assert.equal(manifest.entries[0].parentHash, corpusSourceHash(advanced));
  assert.equal(
    manifest.entries[0].promptHash,
    createHash('sha256').update(advanced.imagePrompt.trim()).digest('hex'),
  );
});

test('incremental vocabulary preparation enriches every new card once and repairs critical legacy gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-vocab-source-'));
  const corpusPath = join(root, 'corpus.json');
  const outputPath = join(root, 'source.json');
  const now = Date.now();
  const old = now - 30 * 24 * 60 * 60 * 1_000;
  const legacyExampleOnly = { ...completeCard('legacy-example'), examples: ['Legacy unmarked example.'] };
  const legacyCritical = { ...completeCard('legacy-critical'), ipa: '' };
  const recentExampleOnly = { ...completeCard('recent-example'), examples: ['Recent unmarked example.'] };
  const recentComplete = completeCard('recent-complete');
  const recentAlreadyEnriched = locallyEnriched(completeCard('recent-enriched'));
  const legacyQwen = {
    ...completeCard('legacy-qwen'),
    advancedEnrichment: {
      version: 1,
      provider: 'local-mlx',
      model: 'legacy-qwen',
      generatedAt: 1,
      contentHash: 'legacy',
    },
  };
  const items = [
    { type: 'vocab', savedAt: old, data: legacyExampleOnly, sourceHash: corpusSourceHash(legacyExampleOnly) },
    { type: 'vocab', savedAt: old, data: legacyQwen, sourceHash: corpusSourceHash(legacyQwen) },
    { type: 'vocab', savedAt: old + 1, data: legacyCritical, sourceHash: corpusSourceHash(legacyCritical) },
    { type: 'vocab', savedAt: now, data: recentExampleOnly, sourceHash: corpusSourceHash(recentExampleOnly) },
    { type: 'vocab', savedAt: now + 1, data: recentComplete, sourceHash: corpusSourceHash(recentComplete) },
    {
      type: 'vocab', savedAt: now + 2, data: recentAlreadyEnriched,
      sourceHash: corpusSourceHash(recentAlreadyEnriched),
    },
  ];
  writeFileSync(corpusPath, JSON.stringify({ version: 1, exportedAt: now, items }));

  execFileSync(process.execPath, [
    script('prepare-incremental-vocab-source.mjs'), corpusPath, outputPath, '10', '168',
  ]);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));

  assert.deepEqual(output.entries.map((entry: any) => entry.id), [
    'recent-example', 'recent-complete', 'legacy-critical',
  ]);

  const providerOutputPath = join(root, 'provider-source.json');
  execFileSync(process.execPath, [
    script('prepare-incremental-vocab-source.mjs'), corpusPath, providerOutputPath, '10', '168', 'local-mlx',
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(providerOutputPath, 'utf8')).entries.map((entry: any) => entry.id),
    ['legacy-qwen'],
  );
});

test('Codex vocabulary completion rewrites a new basic card once and binds its advanced marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-codex-vocab-completion-'));
  const sourcePath = join(root, 'source.json');
  const completedPath = join(root, 'completed.json');
  const codexPath = join(root, 'fake-codex.mjs');
  const workDir = join(root, 'work');
  const card = completeCard('new-basic-card');
  writeFileSync(codexPath, fakeCodex);
  chmodSync(codexPath, 0o700);
  writeFileSync(sourcePath, JSON.stringify({
    version: 1,
    model: 'server-basic',
    entries: [{
      id: card.id,
      type: 'vocab',
      sourceHash: corpusSourceHash(card),
      wasArchived: false,
      archiveForUsage: false,
      data: card,
    }],
  }));

  execFileSync(process.execPath, [
    script('complete-corpus-fields.mjs'), sourcePath, completedPath, workDir,
  ], {
    env: {
      ...process.env,
      CODEX_BIN: codexPath,
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_CONCURRENCY: '1',
      VOCAB_COMPLETION_BATCH_SIZE: '1',
    },
  });

  const completed = JSON.parse(readFileSync(completedPath, 'utf8'));
  const advanced = completed.entries[0].data;
  assert.equal(advanced.definition, 'A Codex-generated advanced definition for this exact sense.');
  assert.equal(advanced.advancedEnrichment.provider, 'codex-harness');
  assert.equal(hasCurrentLocalAdvancedEnrichment(advanced), true);

  const refreshedCorpusPath = join(root, 'refreshed-corpus.json');
  const secondSourcePath = join(root, 'second-source.json');
  writeFileSync(refreshedCorpusPath, JSON.stringify({
    version: 1,
    items: [{ ...completed.entries[0], savedAt: Date.now() }],
  }));
  execFileSync(process.execPath, [
    script('prepare-incremental-vocab-source.mjs'), refreshedCorpusPath, secondSourcePath, '10', '168',
  ]);
  assert.equal(JSON.parse(readFileSync(secondSourcePath, 'utf8')).entries.length, 0);
});
