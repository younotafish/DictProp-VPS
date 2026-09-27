import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  claudeStructuredResult,
  resolveStructuredModel,
  runStructuredModel,
} from '../../scripts/offline/structured-model.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const icon = join(repoRoot, 'public', 'pwa-192x192.png');
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } },
};

// Records its invocation, then answers like `claude -p` in JSON or stream-json output mode.
const fakeClaude = `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    input,
    cwd: process.cwd(),
    effortOverride: process.env.CLAUDE_CODE_EFFORT_LEVEL,
  }));
  const envelope = process.env.FAKE_CLAUDE_FAIL
    ? { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'schema retries exhausted' }
    : { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { value: 'claude' } };
  process.stdout.write('Using AI Gateway (Vertex upstream)\\n');
  if (process.argv.includes('stream-json')) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\\n');
  }
  process.stdout.write(JSON.stringify(envelope) + '\\n');
});
`;

const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({ argv: process.argv.slice(2), input }));
  fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({ value: 'codex' }));
});
`;

function withFakeModel(source: string, run: (paths: { root: string; bin: string; log: string }) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'dictprop-structured-model-'));
    const bin = join(root, 'model.cjs');
    const log = join(root, 'invocation.json');
    writeFileSync(bin, source);
    chmodSync(bin, 0o700);
    const previous = { ...process.env };
    process.env.FAKE_MODEL_LOG = log;
    try {
      await run({ root, bin, log });
    } finally {
      process.env = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('structured model provider defaults to local Claude Opus 5.5 and keeps Codex selectable', () => {
  assert.deepEqual(resolveStructuredModel({}), {
    provider: 'claude',
    marker: 'claude-code',
    label: 'Claude Code',
    cacheKey: 'claude-code-v1',
    model: 'claude-opus-5-5',
    reasoningEffort: 'xhigh',
  });
  const codex = resolveStructuredModel({ ENRICHMENT_MODEL_PROVIDER: 'codex' });
  assert.equal(codex.marker, 'codex-harness');
  assert.equal(codex.cacheKey, 'codex-cli-v2');
  assert.equal(codex.model, 'gpt-5.6-sol');
  assert.equal(resolveStructuredModel({ CLAUDE_REASONING_EFFORT: 'max' }).reasoningEffort, 'max');
  assert.throws(() => resolveStructuredModel({ ENRICHMENT_MODEL_PROVIDER: 'deepinfra' }), /claude" or "codex/);
});

test('Claude result parsing skips launcher output and rejects failed envelopes', () => {
  assert.deepEqual(claudeStructuredResult(
    'Using AI Gateway (Vertex upstream)\n{"type":"result","subtype":"success","is_error":false,"structured_output":{"value":"x"}}\n',
  ), { value: 'x' });
  assert.deepEqual(claudeStructuredResult(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '```json\n{"value":"fenced"}\n```',
  })), { value: 'fenced' });
  assert.throws(() => claudeStructuredResult(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom',
  })), /Claude failed \(error_during_execution\): boom/);
});

test('Claude text requests use JSON output, no tools, and an isolated working directory', withFakeModel(
  fakeClaude,
  async ({ root, bin, log }) => {
    process.env.CLAUDE_BIN = bin;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
    const resultPath = join(root, 'result.json');
    await runStructuredModel(resolveStructuredModel({}), {
      prompt: 'Return a value.', schema, schemaPath: join(root, 'unused.json'), resultPath, timeoutMs: 10_000,
    });

    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { value: 'claude' });
    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    assert.deepEqual(invocation.argv.slice(0, 7), ['-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--tools', '']);
    assert.equal(invocation.argv[invocation.argv.indexOf('--json-schema') + 1], JSON.stringify(schema));
    assert.deepEqual(invocation.argv.slice(-2), ['--output-format', 'json']);
    assert.equal(invocation.argv.includes('--bare'), false);
    assert.equal(invocation.input, 'Return a value.');
    assert.equal(invocation.effortOverride, 'xhigh');
    assert.notEqual(invocation.cwd, repoRoot);
    assert.equal(existsSync(invocation.cwd), false);
  },
));

test('Claude image requests stream base64 attachments before the prompt', withFakeModel(
  fakeClaude,
  async ({ root, bin, log }) => {
    process.env.CLAUDE_BIN = bin;
    const resultPath = join(root, 'result.json');
    await runStructuredModel(resolveStructuredModel({}), {
      prompt: 'Judge the image.', schema, schemaPath: join(root, 'unused.json'), resultPath,
      images: [icon], timeoutMs: 10_000,
    });

    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    assert.deepEqual(invocation.argv.slice(-5), [
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ]);
    const lines = invocation.input.trim().split('\n');
    assert.equal(lines.length, 1);
    const message = JSON.parse(lines[0]);
    assert.equal(message.type, 'user');
    assert.deepEqual(message.message.content.map((block: { type: string }) => block.type), ['text', 'image', 'text']);
    assert.deepEqual(message.message.content[1].source, {
      type: 'base64', media_type: 'image/png', data: readFileSync(icon).toString('base64'),
    });
    assert.equal(message.message.content[2].text, 'Judge the image.');
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { value: 'claude' });
  },
));

test('failed Claude envelopes do not leave a cached result', withFakeModel(
  fakeClaude,
  async ({ root, bin }) => {
    process.env.CLAUDE_BIN = bin;
    process.env.FAKE_CLAUDE_FAIL = '1';
    const resultPath = join(root, 'result.json');
    await assert.rejects(runStructuredModel(resolveStructuredModel({}), {
      prompt: 'Return a value.', schema, schemaPath: join(root, 'unused.json'), resultPath, timeoutMs: 10_000,
    }), /schema retries exhausted/);
    assert.equal(existsSync(resultPath), false);
  },
));

test('Codex requests keep the schema file and image attachment flags', withFakeModel(
  fakeCodex,
  async ({ root, bin, log }) => {
    process.env.CODEX_BIN = bin;
    const schemaPath = join(root, 'schema.json');
    const resultPath = join(root, 'result.json');
    writeFileSync(schemaPath, JSON.stringify(schema));
    await runStructuredModel(resolveStructuredModel({ ENRICHMENT_MODEL_PROVIDER: 'codex' }), {
      prompt: 'Judge the image.', schema, schemaPath, resultPath, images: [icon], timeoutMs: 10_000,
    });

    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(invocation.argv[0], 'exec');
    assert.equal(invocation.argv[invocation.argv.indexOf('-i') + 1], icon);
    assert.equal(invocation.argv[invocation.argv.indexOf('--output-schema') + 1], schemaPath);
    assert.equal(invocation.input, 'Judge the image.');
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { value: 'codex' });
  },
));
