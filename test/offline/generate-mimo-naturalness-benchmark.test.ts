import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExecutable } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'generate-mimo-naturalness-benchmark.mjs');

// Stand-ins for curl and ffmpeg: curl records its arguments and the header files it was handed, then answers with a
// tiny clip; ffmpeg copies its input to its last argument.
const fakeCurl = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const headerFiles = args.filter((arg, index) => args[index - 1] === '-H' && arg.startsWith('@'))
  .map(arg => readFileSync(arg.slice(1), 'utf8'));
appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ args, headerFiles }) + '\\n');
process.stdout.write(JSON.stringify({ audio: 'data:audio/wav;base64,' + Buffer.from('wav bytes').toString('base64') }));
`;
const fakeFfmpeg = `#!/usr/bin/env node
const { copyFileSync } = require('node:fs');
const args = process.argv.slice(2);
copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-mimo-benchmark-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeExecutable(join(bin, 'curl.cjs'), fakeCurl);
  writeExecutable(join(bin, 'curl'), `#!/bin/sh\nexec node "${join(bin, 'curl.cjs')}" "$@"\n`);
  writeExecutable(join(bin, 'ffmpeg.cjs'), fakeFfmpeg);
  writeExecutable(join(bin, 'ffmpeg'), `#!/bin/sh\nexec node "${join(bin, 'ffmpeg.cjs')}" "$@"\n`);
  return { root, bin, log: join(root, 'curl.jsonl'), output: join(root, 'clips') };
}

test('the MiMo benchmark hands curl its API key in a private file, never on the command line', () => {
  const { root, bin, log, output } = setup();
  const scratch = join(root, 'tmp');
  mkdirSync(scratch);

  const result = spawnSync(process.execPath, [
    script, '--output', output, '--sentence-limit', '2', '--ffmpeg', join(bin, 'ffmpeg'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEEPINFRA_API_KEY: 'secret-key', FAKE_CURL_LOG: log, TMPDIR: scratch },
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; headerFiles: string[] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(!call.args.some(arg => arg.includes('secret-key')), JSON.stringify(call.args));
    assert.deepEqual(call.headerFiles, ['Authorization: Bearer secret-key\n']);
    assert.ok(call.args.includes('Content-Type: application/json'));
  }
  // The key file is gone once the run ends.
  assert.deepEqual(readdirSync(scratch), []);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 2);
  for (const entry of manifest.entries) assert.equal(readFileSync(join(output, entry.file), 'utf8'), 'wav bytes');
  assert.equal(existsSync(join(output, `${manifest.entries[0].file}.tmp`)), false);
});
