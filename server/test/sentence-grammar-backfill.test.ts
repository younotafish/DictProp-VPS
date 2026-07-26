import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const prepareSourceScript = fileURLToPath(new URL('../../scripts/offline/prepare-saved-sentence-grammar-source.mjs', import.meta.url));
const enrichGrammarScript = fileURLToPath(new URL('../../scripts/offline/enrich-sentence-grammar.mjs', import.meta.url));
const prepareWaveScript = fileURLToPath(new URL('../../scripts/offline/prepare-saved-sentence-analysis-wave.mjs', import.meta.url));

const grammar = {
  structure: 'A simple declarative clause with a subject and predicate.',
  points: [{
    label: 'Simple past',
    excerpt: 'worked',
    explanation: 'The simple past presents the event as completed.',
  }],
};
const analysis = {
  translation: '它起作用了。',
  naturalSpeechIpa: '/ɪt wɝkt/',
  grammar,
  americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph showing a repaired machine operating, without text.',
};

test('saved-sentence grammar tooling preserves analyses and stages analysis-only updates', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-sentence-grammar-'));
  try {
    const corpusPath = join(root, 'corpus.json');
    const preparedDir = join(root, 'prepared');
    writeFileSync(corpusPath, JSON.stringify({
      version: 1,
      exportedAt: 100,
      items: [
        { id: 'one', type: 'sentence', data: {
          id: 'one', text: 'It worked.', sourceWord: 'work', analysis, analysisGeneratedAt: 90,
        } },
        { id: 'two', type: 'sentence', data: {
          id: 'two', text: 'This is new.', sourceWord: 'new',
        } },
      ],
    }));
    const summary = JSON.parse(execFileSync(process.execPath, [
      prepareSourceScript, corpusPath, preparedDir,
    ], { encoding: 'utf8' }));
    assert.deepEqual(summary, {
      savedSentences: 2,
      existingAnalyses: 1,
      existingGrammar: 1,
      missingAnalyses: 1,
    });

    const sourcePath = join(root, 'complete-source.json');
    const analysisPath = join(root, 'complete-analysis.json');
    const outputPath = join(root, 'grammar-analysis.json');
    const textHash = createHash('sha256').update('It worked.').digest('hex');
    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: [{ id: 'one', text: 'It worked.', sourceWord: 'work', textHash }],
    }));
    writeFileSync(analysisPath, JSON.stringify({
      version: 1,
      generatedAt: 90,
      entries: [{ id: 'one', textHash, analysis, generatedAt: 90 }],
    }));
    execFileSync(process.execPath, [enrichGrammarScript, sourcePath, analysisPath, outputPath, join(root, 'work')]);
    const enriched = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(enriched.entries[0].analysis, analysis);
    assert.equal(JSON.parse(readFileSync(join(root, 'work/progress.json'), 'utf8')).status, 'complete');

    const waveDir = join(root, 'wave');
    const waveSummary = JSON.parse(execFileSync(process.execPath, [
      prepareWaveScript, outputPath, waveDir, '5000',
    ], { encoding: 'utf8' }));
    assert.deepEqual(waveSummary, { sourceEntries: 1, previouslyPublished: 0, waveEntries: 1 });
    const wave = JSON.parse(readFileSync(join(waveDir, 'manifest.json'), 'utf8'));
    assert.equal(wave.entries[0].imageFile, undefined);
    assert.deepEqual(wave.entries[0].analysis.grammar, grammar);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
