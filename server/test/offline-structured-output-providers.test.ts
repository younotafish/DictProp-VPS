import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  runClaudeStructured,
  runMetaStructured,
} from '../../scripts/offline/structured-output-providers.mjs';

const applyScript = fileURLToPath(
  new URL('../../scripts/offline/apply-reviewed-natural-ipa.mjs', import.meta.url),
);
const naturalIpaScript = fileURLToPath(
  new URL('../../scripts/offline/generate-sentence-natural-ipa.mjs', import.meta.url),
);
const checkpointIpaScript = fileURLToPath(
  new URL('../../scripts/offline/checkpoint-reviewed-natural-ipa.mjs', import.meta.url),
);
const mergeIpaScript = fileURLToPath(
  new URL('../../scripts/offline/merge-reviewed-natural-ipa.mjs', import.meta.url),
);
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

test('Claude and Meta structured providers extract schema-bound JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-structured-providers-'));
  try {
    const claude = join(root, 'claude.mjs');
    const curl = join(root, 'curl.cjs');
    writeFileSync(claude, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({
  type: 'result', is_error: false, structured_output: { value: 'claude' }
})));
`);
    writeFileSync(curl, `#!/usr/bin/env node
if (process.argv.some(value => value.includes('test-secret'))) process.exit(2);
if (!process.argv.includes('--retry-all-errors')) process.exit(3);
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ value: 'meta' }) } }]
})));
`);
    chmodSync(claude, 0o700);
    chmodSync(curl, 0o700);

    assert.deepEqual(await runClaudeStructured({
      prompt: 'test', schema, model: 'test', timeoutMs: 5_000, bin: claude,
    }), { value: 'claude' });
    assert.deepEqual(await runMetaStructured({
      prompt: 'test', schema, model: 'test', timeoutMs: 5_000, bin: curl, apiKey: 'test-secret',
    }), { value: 'meta' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed IPA replaces only the fluent transcription in detailed analysis', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-reviewed-ipa-'));
  try {
    const analysisPath = join(root, 'analysis.json');
    const ipaPath = join(root, 'ipa.json');
    const outputPath = join(root, 'output.json');
    writeFileSync(analysisPath, JSON.stringify({
      version: 1,
      generatedAt: 10,
      entries: [{
        id: 'one',
        textHash: 'hash',
        generatedAt: 10,
        analysis: {
          translation: 'translation',
          pronunciation: { slowIpa: '/slow/', fastIpa: '/old/' },
          naturalSpeechIpa: '/old/',
        },
      }],
    }));
    writeFileSync(ipaPath, JSON.stringify({
      version: 1,
      generatedAt: 20,
      entries: [{ id: 'one', textHash: 'hash', naturalSpeechIpa: '/new/', generatedAt: 20 }],
    }));
    const result = spawnSync(process.execPath, [applyScript, analysisPath, ipaPath, outputPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(output.entries[0].analysis.pronunciation.slowIpa, '/slow/');
    assert.equal(output.entries[0].analysis.pronunciation.fastIpa, '/new/');
    assert.equal(output.entries[0].analysis.naturalSpeechIpa, '/new/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Meta IPA batches are split into bounded replayable requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-meta-ipa-batches-'));
  try {
    const curl = join(root, 'curl.cjs');
    const sourcePath = join(root, 'source.json');
    const outputPath = join(root, 'ipa.json');
    const workPath = join(root, 'work');
    const callLog = join(root, 'calls.log');
    writeFileSync(curl, `#!/usr/bin/env node
const fs = require('node:fs');
const dataIndex = process.argv.indexOf('--data-binary');
const bodyPath = process.argv[dataIndex + 1].slice(1);
const body = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
const prompt = body.messages[0].content;
const marker = '\\n\\nINPUT:\\n';
const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
fs.appendFileSync(process.env.CALL_LOG, String(input.length) + '\\n');
const results = input.map(record => ({
  itemIndex: record.itemIndex,
  naturalSpeechIpa: '/ðɪs ɪz ə kəmˈplit ˈtɛst ˈsɛntəns/'
}));
process.stdout.write(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ results }) } }]
}));
`);
    chmodSync(curl, 0o700);
    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: Array.from({ length: 5 }, (_, index) => ({
        id: `sentence-${index}`,
        text: 'This is a complete test sentence.',
        sourceWord: 'test',
      })),
    }));

    const result = spawnSync(process.execPath, [naturalIpaScript, sourcePath, outputPath, workPath], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        CALL_LOG: callLog,
        CURL_BIN: curl,
        DEEPINFRA_API_KEY: 'test-secret',
        IPA_CODEX_CONCURRENCY: '0',
        IPA_CLAUDE_CONCURRENCY: '0',
        IPA_META_CONCURRENCY: '1',
        IPA_BATCH_SIZE: '5',
        IPA_META_REQUEST_BATCH_SIZE: '2',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(callLog, 'utf8').trim().split('\n').map(Number), [2, 2, 1, 2, 2, 1]);
    assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).entries.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed IPA checkpoints preserve completed batches across a larger-batch restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ipa-checkpoint-'));
  try {
    const sourcePath = join(root, 'source.json');
    const workPath = join(root, 'work');
    const partialPath = join(root, 'partial.json');
    const remainingPath = join(root, 'remaining.json');
    const generatedPath = join(root, 'generated.json');
    const mergedPath = join(root, 'merged.json');
    const sentences = Array.from({ length: 5 }, (_, index) => ({
      id: `sentence-${index}`,
      text: 'This is a complete test sentence.',
      sourceWord: 'test',
    }));
    const ipa = '/ðɪs ɪz ə kəmˈplit ˈtɛst ˈsɛntəns/';
    writeFileSync(sourcePath, JSON.stringify({ version: 1, sentences }));
    mkdirSync(workPath);
    writeFileSync(join(workPath, 'review-codex-0001-first.json'), JSON.stringify({
      results: [{ itemIndex: 0, naturalSpeechIpa: ipa }, { itemIndex: 1, naturalSpeechIpa: ipa }],
    }));
    writeFileSync(join(workPath, 'review-meta-0002-invalid.json'), JSON.stringify({
      results: [{ itemIndex: 0, naturalSpeechIpa: 'not ipa' }],
    }));
    writeFileSync(join(workPath, 'review-claude-0003-last.json'), JSON.stringify({
      results: [{ itemIndex: 0, naturalSpeechIpa: ipa }],
    }));

    const checkpoint = spawnSync(process.execPath, [
      checkpointIpaScript, sourcePath, workPath, '2', partialPath, remainingPath,
    ], { encoding: 'utf8' });
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    const checkpointReport = JSON.parse(checkpoint.stdout);
    assert.equal(checkpointReport.reviewedSentences, 3);
    assert.equal(checkpointReport.remainingSentences, 2);
    assert.equal(checkpointReport.invalidCandidates, 1);
    const remaining = JSON.parse(readFileSync(remainingPath, 'utf8'));
    assert.deepEqual(remaining.sentences.map((sentence: { id: string }) => sentence.id), [
      'sentence-2', 'sentence-3',
    ]);
    writeFileSync(generatedPath, JSON.stringify({
      version: 1,
      model: 'cross-reviewed:test',
      generatedAt: 20,
      entries: remaining.sentences.map((sentence: { id: string; text: string }) => ({
        id: sentence.id,
        textHash: createHash('sha256').update(sentence.text).digest('hex'),
        naturalSpeechIpa: ipa,
        generatedAt: 20,
      })),
    }));

    const merge = spawnSync(process.execPath, [
      mergeIpaScript, sourcePath, mergedPath, partialPath, generatedPath,
    ], { encoding: 'utf8' });
    assert.equal(merge.status, 0, merge.stderr);
    const merged = JSON.parse(readFileSync(mergedPath, 'utf8'));
    assert.deepEqual(merged.entries.map((entry: { id: string }) => entry.id),
      sentences.map(sentence => sentence.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
