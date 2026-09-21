import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sentenceLookupHash } from '../src/sentence-enrichment.js';

const script = fileURLToPath(new URL('../../scripts/offline/prepare-incremental-example-source.mjs', import.meta.url));
const buildPoolScript = fileURLToPath(new URL('../../scripts/offline/build-example-sentence-pool.mjs', import.meta.url));
const mergeAnalysisScript = fileURLToPath(
  new URL('../../scripts/offline/merge-sentence-analysis-manifests.mjs', import.meta.url),
);
const sentence = (id: string, textHash = `${id}-hash`) => ({ id, textHash, text: id, lookupHash: `${id}-lookup` });
const source = (sentences: any[]) => ({ version: 1, exportedAt: 1, sentences, stats: {} });

test('incremental example source keeps prior discoveries and adds only non-baseline identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-incremental-examples-'));
  try {
    const currentPath = join(root, 'current.json');
    const baselinePath = join(root, 'baseline.json');
    const previousPath = join(root, 'previous.json');
    const outputPath = join(root, 'output.json');
    writeFileSync(baselinePath, JSON.stringify(source([sentence('baseline')])));
    writeFileSync(previousPath, JSON.stringify(source([sentence('previous')])));
    writeFileSync(currentPath, JSON.stringify(source([
      sentence('baseline'),
      sentence('current'),
      sentence('previous', 'current-version'),
    ])));

    execFileSync(process.execPath, [script, currentPath, baselinePath, outputPath, previousPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.sentences.map((entry: any) => entry.id), ['current', 'previous']);
    assert.equal(output.sentences[1].textHash, 'previous-hash');
    assert.equal(output.stats.newlyDiscovered, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incremental example source restores baseline records missing from production coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-incremental-repairs-'));
  try {
    const currentPath = join(root, 'current.json');
    const baselinePath = join(root, 'baseline.json');
    const previousPath = join(root, 'previous.json');
    const outputPath = join(root, 'output.json');
    writeFileSync(baselinePath, JSON.stringify(source([
      sentence('baseline-gap'),
      sentence('baseline-complete'),
    ])));
    writeFileSync(previousPath, JSON.stringify(source([
      { ...sentence('previous'), hasAnalysis: false, hasImage: false },
      { ...sentence('retired'), hasAnalysis: false, hasImage: false },
    ])));
    writeFileSync(currentPath, JSON.stringify({
      ...source([
        { ...sentence('baseline-gap'), hasAnalysis: true, hasImage: false },
        { ...sentence('baseline-complete'), hasAnalysis: true, hasImage: true },
        { ...sentence('current-complete'), hasAnalysis: true, hasImage: true },
        { ...sentence('current-gap'), hasAnalysis: false, hasImage: false },
        { ...sentence('previous', 'current-version'), hasAnalysis: true, hasImage: false },
      ]),
      stats: { exampleEnrichmentCoverageAvailable: true },
    }));

    execFileSync(process.execPath, [script, currentPath, baselinePath, outputPath, previousPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.sentences.map((entry: any) => entry.id), [
      'baseline-gap', 'current-gap', 'previous',
    ]);
    assert.equal(output.sentences[2].textHash, 'previous-hash');
    assert.equal(output.sentences[2].hasAnalysis, true);
    assert.equal(output.sentences[2].hasImage, false);
    assert.equal(output.stats.coverageRepairs, 1);
    assert.equal(output.stats.newlyDiscovered, 1);
    assert.equal(output.stats.retired, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('example pool carries encrypted production enrichment coverage into local reconciliation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-example-coverage-'));
  try {
    const corpusPath = join(root, 'corpus.json');
    const outputPath = join(root, 'pool.json');
    const covered = 'This {{example}} already has an analysis.';
    const incomplete = 'This {{example}} has an obsolete analysis.';
    const missing = 'This {{example}} still needs its content.';
    writeFileSync(corpusPath, JSON.stringify({
      version: 1,
      items: [{
        id: 'vocab',
        type: 'vocab',
        data: { id: 'vocab', examples: [covered, incomplete, missing] },
      }],
      exampleEnrichmentCoverage: [
        { lookupHash: sentenceLookupHash(covered), hasAnalysis: true, hasImage: false },
        { lookupHash: sentenceLookupHash(incomplete), hasAnalysis: false, hasImage: true },
      ],
    }));

    execFileSync(process.execPath, [buildPoolScript, corpusPath, outputPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    const byText = new Map<string, any>(output.sentences.map((entry: any) => [entry.text, entry]));
    assert.deepEqual(
      { hasAnalysis: byText.get(covered).hasAnalysis, hasImage: byText.get(covered).hasImage },
      { hasAnalysis: true, hasImage: false },
    );
    assert.deepEqual(
      { hasAnalysis: byText.get(incomplete).hasAnalysis, hasImage: byText.get(incomplete).hasImage },
      { hasAnalysis: false, hasImage: true },
    );
    assert.deepEqual(
      { hasAnalysis: byText.get(missing).hasAnalysis, hasImage: byText.get(missing).hasImage },
      { hasAnalysis: false, hasImage: false },
    );
    assert.equal(output.stats.exampleEnrichmentCoverageAvailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('example pool uses a same-cycle local vocabulary overlay', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-example-overlay-'));
  try {
    const corpusPath = join(root, 'corpus.json');
    const overlayPath = join(root, 'overlay.json');
    const outputPath = join(root, 'pool.json');
    writeFileSync(corpusPath, JSON.stringify({
      version: 1,
      items: [{
        id: 'vocab',
        type: 'vocab',
        data: { id: 'vocab', word: 'sample', sense: 'noun: example', examples: ['A basic {{sample}}.'] },
      }],
      exampleEnrichmentCoverage: [],
    }));
    writeFileSync(overlayPath, JSON.stringify({
      version: 1,
      entries: [{
        id: 'vocab',
        type: 'vocab',
        archiveForUsage: false,
        data: {
          id: 'vocab', word: 'sample', sense: 'noun: example',
          examples: [
            'I brought home a {{sample}} before choosing the paint color.',
            'The lab tested a {{sample}} from every shipment.',
          ],
        },
      }],
    }));

    execFileSync(process.execPath, [buildPoolScript, corpusPath, outputPath, overlayPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.sentences.map((entry: any) => entry.text), [
      'The lab tested a {{sample}} from every shipment.',
      'I brought home a {{sample}} before choosing the paint color.',
    ].sort((left, right) => sentenceLookupHash(left).localeCompare(sentenceLookupHash(right))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analysis manifest merge prefers the newest reusable entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-analysis-merge-'));
  try {
    const basePath = join(root, 'base.json');
    const recentPath = join(root, 'recent.json');
    const outputPath = join(root, 'output.json');
    writeFileSync(basePath, JSON.stringify({
      version: 1,
      generatedAt: 10,
      entries: [
        { id: 'shared', textHash: 'old', analysis: { value: 'old' }, generatedAt: 10 },
        { id: 'base', textHash: 'base', analysis: { value: 'base' }, generatedAt: 10 },
      ],
    }));
    writeFileSync(recentPath, JSON.stringify({
      version: 1,
      generatedAt: 20,
      entries: [{ id: 'shared', textHash: 'new', analysis: { value: 'new' }, generatedAt: 20 }],
    }));

    execFileSync(process.execPath, [mergeAnalysisScript, outputPath, basePath, recentPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.entries.map((entry: any) => [entry.id, entry.textHash]), [
      ['base', 'base'],
      ['shared', 'new'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
