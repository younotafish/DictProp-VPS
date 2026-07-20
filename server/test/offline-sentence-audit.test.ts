import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const scripts = resolve('..', 'scripts', 'offline');

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('usage adjudication freezes a meaning linked to a saved sentence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-usage-'));
  const corpusPath = join(root, 'corpus.json');
  const sourcePath = join(root, 'source.json');
  const adjudicationPath = join(root, 'adjudication.json');
  const outputPath = join(root, 'output.json');
  const saved = 'The saved sentence uses {{focus}} precisely.';
  const unsaved = 'The old example uses {{focus}} awkwardly.';
  const replacement = 'The revised example uses {{focus}} naturally.';

  writeJson(corpusPath, {
    version: 1,
    entries: [
      {
        id: 'card-1',
        type: 'vocab',
        data: { id: 'card-1', word: 'focus', sense: 'direct attention', examples: [saved, unsaved] },
      },
      {
        id: 'sentence-1',
        type: 'sentence',
        data: { id: 'sentence-1', text: saved, sourceWord: 'focus', sourceSense: 'direct attention' },
      },
    ],
  });
  writeJson(sourcePath, {
    version: 1,
    sentences: [{ id: 'example-1', text: unsaved }],
  });
  writeJson(adjudicationPath, {
    version: 1,
    generatedAt: 1,
    model: 'test',
    entries: [{
      parentId: 'card-1',
      parentType: 'vocab',
      cardId: 'card-1',
      cardIndex: 0,
      word: 'focus',
      sense: 'direct attention',
      examples: [{ id: 'example-1', text: unsaved }],
      adjudicatedAt: 1,
      decision: {
        lexicalAction: 'keep',
        correctedWord: '',
        correctedSense: '',
        correctedForms: [],
        usageStatus: 'current_general',
        usageReason: 'Normal current English shared across major varieties.',
        confidence: 'high',
        examples: [{ exampleIndex: 0, action: 'rewrite', replacement, reason: 'Improve the collocation.' }],
      },
    }],
  });

  execFileSync(process.execPath, [
    join(scripts, 'apply-sentence-usage-adjudications.mjs'),
    corpusPath,
    sourcePath,
    adjudicationPath,
    outputPath,
  ]);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.deepEqual(output.entries[0].data.examples, [saved, unsaved]);
  assert.equal(output.entries[1].data.text, saved);
});

test('full sentence-analysis audit uses the authoritative manifest when raw cache files are absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-analysis-audit-'));
  const sourcePath = join(root, 'source.json');
  const analysisPath = join(root, 'analysis.json');
  const reportPath = join(root, 'report.json');
  const workDir = join(root, 'work');
  mkdirSync(workDir);
  const sentence = {
    id: 'example-1',
    text: 'The wording is not American.',
    textHash: 'hash-1',
    provenance: [{ usageStatus: 'current_general' }],
  };
  writeJson(sourcePath, { version: 1, sentences: [sentence] });
  writeJson(analysisPath, {
    version: 1,
    entries: [{
      id: sentence.id,
      textHash: sentence.textHash,
      analysis: {
        translation: '这种表达不是美式英语。',
        naturalSpeechIpa: '/ðə ˈwɝdːdɪŋ ɪz nɑt əˈmɛrɪkən/',
        americanEnglish: { status: 'not_american', explanation: 'The wording is not current American English.' },
        terms: [],
        imagePrompt: 'A realistic photograph depicting the complete sentence clearly.',
      },
    }],
  });

  const stdout = execFileSync(process.execPath, [
    join(scripts, 'audit-sentence-analysis-cache.mjs'),
    sourcePath,
    workDir,
    reportPath,
    analysisPath,
  ], { encoding: 'utf8' });
  const stats = JSON.parse(stdout);
  assert.equal(stats.cachedAnalyses, 0);
  assert.equal(stats.auditedAnalyses, 1);
  assert.equal(stats.notAmericanActive, 1);
});

test('American-usage gate rejects current conflicts and permits independently adjudicated specialized usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-american-gate-'));
  const sourcePath = join(root, 'source.json');
  const analysisPath = join(root, 'analysis.json');
  const overridesPath = join(root, 'overrides.json');
  const usagePath = join(root, 'usage.json');
  const corpusPath = join(root, 'corpus.json');
  const sentence = { id: 'example-1', text: 'Regional wording.', textHash: 'hash-1' };
  const analysis = {
    version: 1,
    entries: [{
      id: sentence.id,
      textHash: sentence.textHash,
      analysis: { americanEnglish: { status: 'not_american', explanation: 'Regional terminology.' } },
    }],
  };
  writeJson(analysisPath, analysis);
  writeJson(overridesPath, { version: 1, entries: [] });
  writeJson(usagePath, { version: 1, entries: [] });
  writeJson(corpusPath, { version: 1, entries: [] });
  writeJson(sourcePath, {
    version: 1,
    sentences: [{ ...sentence, provenance: [{ usageStatus: 'current_general' }] }],
  });

  const rejected = spawnSync(process.execPath, [
    join(scripts, 'verify-example-sentence-american-usage.mjs'),
    sourcePath,
    analysisPath,
    overridesPath,
    usagePath,
    corpusPath,
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);

  writeJson(sourcePath, {
    version: 1,
    sentences: [{
      ...sentence,
      provenance: [{
        parentId: 'card-1',
        parentType: 'vocab',
        cardId: 'card-1',
        usageStatus: 'current_general',
      }],
    }],
  });
  writeJson(corpusPath, {
    version: 1,
    entries: [
      {
        id: 'card-1',
        type: 'vocab',
        data: { id: 'card-1', word: 'focus', sense: 'direct attention', examples: [sentence.text] },
      },
      {
        id: 'saved-1',
        type: 'sentence',
        data: { id: 'saved-1', text: 'Saved text.', sourceWord: 'focus', sourceSense: 'direct attention' },
      },
    ],
  });
  writeJson(usagePath, {
    version: 1,
    entries: [{
      parentId: 'card-1',
      cardId: 'card-1',
      examples: [{ id: sentence.id }],
      decision: { examples: [{ action: 'rewrite' }] },
    }],
  });
  execFileSync(process.execPath, [
    join(scripts, 'verify-example-sentence-american-usage.mjs'),
    sourcePath,
    analysisPath,
    overridesPath,
    usagePath,
    corpusPath,
  ]);

  writeJson(sourcePath, {
    version: 1,
    sentences: [{ ...sentence, provenance: [{ usageStatus: 'narrow_specialized' }] }],
  });
  writeJson(usagePath, { version: 1, entries: [] });
  writeJson(corpusPath, { version: 1, entries: [] });
  writeJson(overridesPath, {
    version: 1,
    entries: [{
      id: sentence.id,
      textHash: sentence.textHash,
      americanEnglish: { status: 'not_american', explanation: 'Independently confirmed regional terminology.' },
    }],
  });
  execFileSync(process.execPath, [
    join(scripts, 'verify-example-sentence-american-usage.mjs'),
    sourcePath,
    analysisPath,
    overridesPath,
    usagePath,
    corpusPath,
  ]);
});
