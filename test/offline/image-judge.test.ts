import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExecutable, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Answers like `claude -p`, logging each request: images whose brief says "reject" are rejected.
const fakeClaude = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const prompt = JSON.parse(input).message.content.filter(block => block.type === 'text').map(block => block.text).join('\\n');
  const records = JSON.parse(prompt.split('\\n').find(line => line.startsWith('[{"itemIndex"')));
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify(records.map(record => record.brief)) + '\\n');
  const results = records.map(record => ({ itemIndex: record.itemIndex, acceptable: !record.brief.includes('reject'), reason: 'Fake.' }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { results } }) + '\\n');
});
`;

function judgeSetup(t: test.TestContext, briefs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-judge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = {
    root,
    candidates: join(root, 'candidates'),
    images: join(root, 'images'),
    work: join(root, 'work'),
    targets: join(root, 'targets.json'),
    calls: join(root, 'calls.log'),
    claude: join(root, 'claude.cjs'),
  };
  mkdirSync(paths.candidates);
  mkdirSync(paths.images);
  writeExecutable(paths.claude, fakeClaude);
  const targets = Object.entries(briefs).map(([imageId, prompt]) => ({
    imageId, filename: `${imageId}.webp`, prompt, learningTarget: { kind: 'word sense', text: imageId, sense: '', definition: '' },
  }));
  for (const target of targets) writeFileSync(join(paths.candidates, `${target.imageId}-1.webp`), `candidate for ${target.imageId}`);
  writeJson(paths.targets, { version: 1, targets });
  const run = () => spawnSync(process.execPath, [
    repoPath('scripts', 'offline', 'judge-image-candidates.mjs'), paths.targets, paths.candidates, paths.images, paths.work, '1',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ENRICHMENT_MODEL_PROVIDER: 'claude', CLAUDE_BIN: paths.claude, FAKE_CALLS: paths.calls, CODEX_RETRY_DELAY_MS: '0' },
  });
  const calls = () => (existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  const rejected = () => JSON.parse(readFileSync(join(paths.work, 'rejected-targets.json'), 'utf8')).targets
    .map((target: { imageId: string }) => target.imageId);
  return { paths, run, calls, rejected };
}

test('an empty file where an accepted image belongs is judged again and replaced', t => {
  const { paths, run, calls, rejected } = judgeSetup(t, { empty: 'A harbor at dawn.', done: 'A lighthouse.', other: 'A reject me.' });
  writeFileSync(join(paths.images, 'empty.webp'), '');
  writeFileSync(join(paths.images, 'done.webp'), 'accepted earlier');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [['A harbor at dawn.', 'A reject me.']]);
  assert.equal(readFileSync(join(paths.images, 'empty.webp'), 'utf8'), 'candidate for empty');
  assert.equal(readFileSync(join(paths.images, 'done.webp'), 'utf8'), 'accepted earlier');
  assert.deepEqual(rejected(), ['other']);
  assert.match(result.stderr, /Accepted 1\/2; rejected 1/);
});
