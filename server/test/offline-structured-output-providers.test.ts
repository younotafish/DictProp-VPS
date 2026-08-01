import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const curl = join(root, 'curl.mjs');
    writeFileSync(claude, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({
  type: 'result', is_error: false, structured_output: { value: 'claude' }
})));
`);
    writeFileSync(curl, `#!/usr/bin/env node
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
      prompt: 'test', schema, model: 'test', timeoutMs: 5_000, bin: curl, apiKey: 'test',
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

