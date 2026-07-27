import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectIncompleteSavedSentences } from '../src/incremental-saved-sentences.js';

const waveScript = fileURLToPath(new URL(
  '../../scripts/offline/prepare-saved-sentence-analysis-wave.mjs',
  import.meta.url,
));
const reconcileScript = fileURLToPath(new URL(
  '../../scripts/offline/reconcile-sentence-analyses.mjs',
  import.meta.url,
));

const completeAnalysis = {
  translation: '它起作用了。',
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in educated American English.',
    evidence: ['The simple wording is shared across major English varieties.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ɪt wɝkt/',
    fastIpa: '/ɪt wɝkt/',
    carefulSpeakerGuide: 'IT WORKED',
    fastSpeechFeatures: ['worked: the final consonant cluster is released lightly.'],
    intonationAndChunking: 'It worked ↘',
    keyDifference: 'Fast speech uses a lighter final release.',
  },
  grammar: {
    structure: 'A simple declarative clause with a subject and past-tense predicate.',
    points: [{
      label: 'Simple past',
      excerpt: 'worked',
      explanation: 'The simple past presents the result as a completed event.',
    }],
  },
  imagePrompt: 'A realistic photograph of a repaired machine operating successfully in natural light.',
};

test('saved-sentence discovery uses the complete analysis contract and notices text changes', () => {
  const changedOldHash = createHash('sha256').update('Old text.').digest('hex');
  const corpus = {
    version: 1,
    exportedAt: 50,
    items: [
      { type: 'sentence', data: { id: 'complete', text: 'It worked.', analysis: completeAnalysis } },
      { type: 'sentence', data: {
        id: 'legacy', text: 'Legacy.', analysis: { ...completeAnalysis, pronunciation: undefined },
      } },
      { type: 'sentence', data: { id: 'changed', text: 'New text.' } },
      { type: 'sentence', wasArchived: true, data: { id: 'archived', text: 'Skip me.' } },
      { type: 'vocab', data: { id: 'word', word: 'word' } },
    ],
  };
  const previous = {
    version: 1,
    sentences: [{ id: 'changed', textHash: changedOldHash }],
  };

  const source = collectIncompleteSavedSentences(corpus, previous, 100);
  assert.deepEqual(source.sentences.map(sentence => sentence.id), ['changed', 'legacy']);
  assert.deepEqual(source.stats, {
    corpusRecords: 5,
    savedSentences: 3,
    incompleteSentences: 2,
    newlyDiscovered: 1,
    changedSentences: 1,
  });
});

test('saved-sentence waves republish the same item id when its text hash changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-incremental-'));
  try {
    const currentPath = join(root, 'current.json');
    const publishedPath = join(root, 'published.json');
    const waveDir = join(root, 'wave');
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const entry = { id: 'same-id', textHash: newHash, analysis: completeAnalysis, generatedAt: 10 };
    writeFileSync(currentPath, JSON.stringify({ version: 1, generatedAt: 10, entries: [entry] }));
    writeFileSync(publishedPath, JSON.stringify({
      version: 1,
      generatedAt: 5,
      entries: [{ ...entry, textHash: oldHash }],
    }));

    const summary = JSON.parse(execFileSync(process.execPath, [
      waveScript, currentPath, waveDir, '100', publishedPath,
    ], { encoding: 'utf8' }));
    assert.equal(summary.waveEntries, 1);
    const wave = JSON.parse(readFileSync(join(waveDir, 'manifest.json'), 'utf8'));
    assert.equal(wave.entries[0].textHash, newHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recurring reconciliation does not reuse a legacy incomplete analysis cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-reconcile-'));
  try {
    const sourcePath = join(root, 'source.json');
    const cachePath = join(root, 'cache.json');
    const outputDir = join(root, 'output');
    const textHash = createHash('sha256').update('It worked.').digest('hex');
    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: [{ id: 'legacy', text: 'It worked.', textHash }],
    }));
    writeFileSync(cachePath, JSON.stringify({
      version: 1,
      generatedAt: 5,
      entries: [{
        id: 'legacy',
        textHash,
        generatedAt: 5,
        analysis: {
          translation: '它起作用了。',
          naturalSpeechIpa: '/ɪt wɝkt/',
          americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
          terms: [],
          grammar: completeAnalysis.grammar,
          imagePrompt: completeAnalysis.imagePrompt,
        },
      }],
    }));

    execFileSync(process.execPath, [reconcileScript, sourcePath, cachePath, outputDir]);
    const report = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8'));
    assert.equal(report.missing, 1);
    assert.equal(report.incompleteBase, 1);
    assert.equal(report.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
