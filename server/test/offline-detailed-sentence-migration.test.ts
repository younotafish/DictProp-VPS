import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const enrichScript = fileURLToPath(new URL('../../scripts/offline/enrich-sentences.mjs', import.meta.url));
const mergeGrammarScript = fileURLToPath(
  new URL('../../scripts/offline/merge-sentence-grammar-manifests.mjs', import.meta.url),
);

const fakeCodex = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const marker = 'ANALYZE THESE SENTENCES:\\n';
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
  appendFileSync(process.env.FAKE_CODEX_CALLS, items.map(item => item.text).join(' | ') + '\\n');
  if (items.length > 1 || (!process.env.ALLOW_SINGLETON_FAILURE && items[0].text.includes('always fails'))) {
    process.stderr.write('deliberate fake provider failure');
    process.exit(2);
  }
  const results = items.map(item => ({
    itemIndex: item.itemIndex,
    analysis: {
      translation: 'A precise translation.',
      americanEnglish: {
        status: 'shared',
        explanation: 'Yes. This sentence is natural in educated American English.',
        evidence: ['Its vocabulary and grammar are shared across major English varieties.'],
      },
      terms: [],
      pronunciation: {
        slowIpa: '/ɪt wɝkt/',
        fastIpa: '/ɪt wɝkt/',
        carefulSpeakerGuide: 'IT WORKED',
        fastSpeechFeatures: ['worked has a lightly released final consonant cluster.'],
        intonationAndChunking: 'It worked ↘',
        keyDifference: 'Fluent speech uses a lighter final release than careful speech.',
      },
      grammar: {
        structure: 'A simple declarative clause.',
        points: [{
          label: 'Clause',
          excerpt: process.env.FAKE_INVALID_GRAMMAR ? 'not in the source sentence' : item.text.split(' ')[0],
          explanation: 'This begins the clause.',
        }],
      },
      imagePrompt: 'A realistic photograph of the described event in natural light, with no visible text.',
    },
  }));
  writeFileSync(outputPath, JSON.stringify({ results }));
});
`;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('detailed sentence migration splits failures, resumes caches, and preserves prior grammar', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-detailed-sentence-'));
  try {
    const fakeCodexPath = join(root, 'fake-codex.mjs');
    const sourcePath = join(root, 'source.json');
    const basePath = join(root, 'base.json');
    const outputPath = join(root, 'analysis.json');
    const workDir = join(root, 'work');
    const callsPath = join(root, 'calls.log');
    const sentences = [
      { id: 'one', text: 'First works.', sourceWord: 'first', textHash: hash('First works.') },
      { id: 'two', text: 'Second works.', sourceWord: 'second', textHash: hash('Second works.') },
      { id: 'three', text: 'This always fails.', sourceWord: 'fail', textHash: hash('This always fails.') },
    ];
    const preservedGrammar = {
      structure: 'Preserved 5.6 grammar.',
      points: [{ label: 'Subject', excerpt: 'First', explanation: 'First is the grammatical subject.' }],
    };
    writeFileSync(fakeCodexPath, fakeCodex);
    chmodSync(fakeCodexPath, 0o700);
    writeFileSync(sourcePath, JSON.stringify({ version: 1, sentences }));
    writeFileSync(basePath, JSON.stringify({
      version: 1,
      entries: [{ id: 'one', textHash: sentences[0].textHash, analysis: { grammar: preservedGrammar } }],
    }));

    const args = [enrichScript, sourcePath, outputPath, workDir, basePath];
    const env = {
      ...process.env,
      CODEX_BIN: fakeCodexPath,
      CODEX_CONCURRENCY: '1',
      CODEX_RETRY_DELAY_MS: '0',
      SENTENCE_ANALYSIS_BATCH_SIZE: '3',
      FAKE_CODEX_CALLS: callsPath,
    };
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.notEqual(first.status, 0);
    assert.equal(existsSync(outputPath), false);
    assert.equal(JSON.parse(readFileSync(join(workDir, 'progress.json'), 'utf8')).status, 'incomplete');
    assert.deepEqual(
      JSON.parse(readFileSync(join(workDir, 'failures.json'), 'utf8')).failures.map((value: any) => value.id),
      ['three'],
    );
    const callsAfterFirstRun = readFileSync(callsPath, 'utf8').trim().split('\n').length;

    const second = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...env, ALLOW_SINGLETON_FAILURE: '1' },
    });
    assert.equal(second.status, 0, second.stderr);
    const callsAfterSecondRun = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    assert.equal(callsAfterSecondRun - callsAfterFirstRun, 1);
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(output.entries.length, 3);
    assert.deepEqual(output.entries[0].analysis.grammar, preservedGrammar);
    assert.equal(output.entries[0].analysis.naturalSpeechIpa, output.entries[0].analysis.pronunciation.fastIpa);
    assert.equal(JSON.parse(readFileSync(join(workDir, 'progress.json'), 'utf8')).status, 'complete');
    assert.equal(existsSync(join(workDir, 'failures.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel detail generation can defer grammar checks before a verified grammar merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-deferred-sentence-grammar-'));
  try {
    const fakeCodexPath = join(root, 'fake-codex.mjs');
    const sourcePath = join(root, 'source.json');
    const outputPath = join(root, 'analysis.json');
    const workDir = join(root, 'work');
    const callsPath = join(root, 'calls.log');
    writeFileSync(fakeCodexPath, fakeCodex);
    chmodSync(fakeCodexPath, 0o700);
    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: [{ id: 'one', text: 'It worked.', sourceWord: 'work', textHash: hash('It worked.') }],
    }));

    const result = spawnSync(process.execPath, [enrichScript, sourcePath, outputPath, workDir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_BIN: fakeCodexPath,
        CODEX_CONCURRENCY: '1',
        CODEX_RETRY_DELAY_MS: '0',
        DEFER_SENTENCE_GRAMMAR_VALIDATION: '1',
        FAKE_CODEX_CALLS: callsPath,
        FAKE_INVALID_GRAMMAR: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).entries.length, 1);
    assert.equal(
      JSON.parse(readFileSync(join(workDir, 'progress.json'), 'utf8')).grammarValidation,
      'deferred',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed GPT-5.6 grammar can replace GPT-5.5 grammar without changing detailed metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-merge-sentence-grammar-'));
  try {
    const detailedPath = join(root, 'detailed.json');
    const grammarPath = join(root, 'grammar.json');
    const outputPath = join(root, 'merged.json');
    const textHash = hash('It worked.');
    const analysis = {
      translation: 'It succeeded.',
      naturalSpeechIpa: '/ɪt wɝkt/',
      americanEnglish: {
        status: 'shared',
        explanation: 'Yes. This is natural in American English.',
        evidence: ['The wording is shared across major English varieties.'],
      },
      terms: [],
      pronunciation: {
        slowIpa: '/ɪt wɝkt/',
        fastIpa: '/ɪt wɝkt/',
        carefulSpeakerGuide: 'IT WORKED',
        fastSpeechFeatures: ['worked can have a lightly released final consonant cluster.'],
        intonationAndChunking: 'It worked with a final fall.',
        keyDifference: 'Fluent delivery uses a lighter final release.',
      },
      grammar: {
        structure: 'GPT-5.5 structure.',
        points: [{ label: 'Subject', excerpt: 'It', explanation: 'It is the subject.' }],
      },
      imagePrompt: 'A realistic photograph of a successful result in natural light, with no visible text.',
    };
    const replacementGrammar = {
      structure: 'Preserved GPT-5.6 structure.',
      points: [{ label: 'Simple past', excerpt: 'worked', explanation: 'Worked presents a completed event.' }],
    };
    writeFileSync(detailedPath, JSON.stringify({
      version: 1,
      generatedAt: 10,
      entries: [{ id: 'one', textHash, generatedAt: 10, analysis }],
    }));
    writeFileSync(grammarPath, JSON.stringify({
      version: 1,
      generatedAt: 20,
      entries: [{
        id: 'one',
        textHash,
        generatedAt: 20,
        analysis: { translation: 'legacy', grammar: replacementGrammar },
      }],
    }));

    const merged = spawnSync(process.execPath, [mergeGrammarScript, detailedPath, grammarPath, outputPath], {
      encoding: 'utf8',
    });
    assert.equal(merged.status, 0, merged.stderr);
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.entries[0].analysis.grammar, replacementGrammar);
    assert.equal(output.entries[0].analysis.translation, analysis.translation);
    assert.equal(output.entries[0].analysis.pronunciation.fastIpa, analysis.pronunciation.fastIpa);
    assert.equal(output.entries[0].generatedAt, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
