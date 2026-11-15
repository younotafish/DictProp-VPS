import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExecutable, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Answers judge, prompt-refinement and readiness requests like `claude -p`, logging each one. Images whose
// brief says "reject" are rejected. A request about a "poison" brief fails the way an output filter fails
// (an error envelope and exit 1), and with FAKE_DOWN every request fails, the readiness check included.
const fakeClaude = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const prompt = process.argv.includes('stream-json')
    ? JSON.parse(input).message.content.filter(block => block.type === 'text').map(block => block.text).join('\\n')
    : input;
  const fail = message => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message }) + '\\n');
    process.exitCode = 1;
  };
  let results;
  if (prompt.includes('automated readiness check')) {
    appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ kind: 'ready' }) + '\\n');
    if (process.env.FAKE_DOWN) return fail('API Error: 401 authentication expired');
    results = undefined;
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { ok: true } }) + '\\n');
    return;
  }
  const line = prompt.split('\\n').find(value => value.startsWith('[{"itemIndex"'));
  const records = JSON.parse(line);
  const judging = records[0].brief !== undefined;
  const briefs = records.map(record => judging ? record.brief : record.rejectedBrief);
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ kind: judging ? 'judge' : 'refine', briefs }) + '\\n');
  if (process.env.FAKE_DOWN) return fail('API Error: 401 authentication expired');
  if (briefs.some(brief => brief.includes('poison'))) return fail('API Error: 400 output blocked by content filtering policy');
  results = records.map(record => judging
    ? { itemIndex: record.itemIndex, acceptable: !record.brief.includes('reject'), reason: 'Fake judgment.' }
    : { itemIndex: record.itemIndex, prompt: record.rejectedBrief + ' Shown as one clear action in natural light, no text.', change: 'Fake refinement.' });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { results } }) + '\\n');
});
`;

type Call = { kind: 'judge' | 'refine' | 'ready'; briefs?: string[] };
type Target = { imageId: string; filename: string; prompt: string; rejectionReason?: string; promptRefinement?: string; originalPrompt?: string };

function imageSetup(t: test.TestContext, briefs: Record<string, string>) {
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
  const run = (script: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [
    repoPath('scripts', 'offline', script), ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ENRICHMENT_MODEL_PROVIDER: 'claude',
      CLAUDE_BIN: paths.claude,
      FAKE_CALLS: paths.calls,
      CODEX_RETRY_DELAY_MS: '0',
      CODEX_IMAGE_CONCURRENCY: '1',
      CODEX_CONCURRENCY: '1',
      ...env,
    },
  });
  const judge = (env?: Record<string, string>) =>
    run('judge-image-candidates.mjs', [paths.targets, paths.candidates, paths.images, paths.work, '1'], env);
  const calls = (): Call[] => (existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  const rejected = (): Target[] => JSON.parse(readFileSync(join(paths.work, 'rejected-targets.json'), 'utf8')).targets;
  return { paths, run, judge, calls, rejected };
}

test('an empty file where an accepted image belongs is judged again and replaced', t => {
  const { paths, judge, calls, rejected } = imageSetup(t, { empty: 'A harbor at dawn.', done: 'A lighthouse.', other: 'A reject me.' });
  writeFileSync(join(paths.images, 'empty.webp'), '');
  writeFileSync(join(paths.images, 'done.webp'), 'accepted earlier');
  const result = judge();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [{ kind: 'judge', briefs: ['A harbor at dawn.', 'A reject me.'] }]);
  assert.equal(readFileSync(join(paths.images, 'empty.webp'), 'utf8'), 'candidate for empty');
  assert.equal(readFileSync(join(paths.images, 'done.webp'), 'utf8'), 'accepted earlier');
  assert.deepEqual(rejected().map(target => target.imageId), ['other']);
  assert.match(result.stderr, /Accepted 1\/2; rejected 1/);
});

test('an image the reviewer cannot judge is rejected on its own, and the rest of its batch is judged', t => {
  const { paths, judge, calls, rejected } = imageSetup(t, {
    one: 'A harbor at dawn.', two: 'A lighthouse, reject me.', three: 'A poison song lyric scene.', four: 'A pier.', five: 'A boat.',
  });
  const result = judge();
  assert.equal(result.status, 0, result.stderr);

  const [two, three] = rejected();
  assert.deepEqual([two.imageId, two.rejectionReason], ['two', 'Fake judgment.']);
  assert.equal(three.imageId, 'three');
  assert.match(three.rejectionReason!, /^The reviewer could not judge this image: Claude exited with 1: /);
  assert.ok(three.rejectionReason!.length <= 'The reviewer could not judge this image: '.length + 200);
  for (const accepted of ['one', 'four', 'five']) {
    assert.equal(readFileSync(join(paths.images, `${accepted}.webp`), 'utf8'), `candidate for ${accepted}`);
  }
  assert.equal(existsSync(join(paths.images, 'three.webp')), false);
  assert.equal(existsSync(join(paths.images, 'two.webp')), false);

  // Three attempts at each size, then one readiness check before the image is blamed.
  const judged = calls().filter(call => call.kind === 'judge').map(call => call.briefs!.length);
  assert.deepEqual(judged, [5, 5, 5, 3, 3, 3, 2, 1, 1, 1, 2]);
  assert.equal(calls().filter(call => call.kind === 'ready').length, 1);
  assert.match(result.stderr, /Image judgment batch 1 failed \([\s\S]*?\); splitting 5 images into 3\+2/);
  assert.match(result.stderr, /Image three could not be judged; rejecting this candidate: /);
  assert.ok(readdirSync(paths.work).some(name => /^split-0001-[0-9a-f]{16}\.json$/.test(name)));
});

test('when the model itself is down, the judge fails as before and blames no image', t => {
  const { paths, judge, calls } = imageSetup(t, { one: 'A harbor at dawn.', two: 'A lighthouse.' });
  const result = judge({ FAKE_DOWN: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed its readiness check as well: .*401 authentication expired/);
  assert.equal(existsSync(join(paths.work, 'rejected-targets.json')), false);
  assert.deepEqual(readdirSync(paths.images), []);
  assert.equal(calls().filter(call => call.kind === 'ready').length, 1);
});

test('a brief the editor cannot rewrite is kept as it was, and the rest are refined in order', t => {
  const { paths, run, calls } = imageSetup(t, {});
  const rejectedPath = join(paths.root, 'rejected.json');
  const output = join(paths.root, 'refined.json');
  const brief = (imageId: string, prompt: string) => ({
    imageId, filename: `${imageId}.webp`, prompt, rejectionReason: 'Unclear.', learningTarget: { kind: 'sentence', text: imageId },
  });
  writeJson(rejectedPath, { version: 1, candidateNumber: 1, targets: [
    brief('one', 'A harbor at dawn.'), brief('two', 'A poison song lyric scene.'), brief('three', 'A pier at night.'),
  ] });
  const result = run('refine-rejected-image-prompts.mjs', [rejectedPath, output, join(paths.root, 'refine-work')]);
  assert.equal(result.status, 0, result.stderr);
  const refined: Target[] = JSON.parse(readFileSync(output, 'utf8')).targets;
  assert.deepEqual(refined.map(target => [target.imageId, target.prompt, target.originalPrompt, target.promptRefinement]), [
    ['one', 'A harbor at dawn. Shown as one clear action in natural light, no text.', 'A harbor at dawn.', 'Fake refinement.'],
    ['two', 'A poison song lyric scene.', 'A poison song lyric scene.', 'unchanged: the prompt editor could not rewrite this brief'],
    ['three', 'A pier at night. Shown as one clear action in natural light, no text.', 'A pier at night.', 'Fake refinement.'],
  ]);
  assert.equal(calls().filter(call => call.kind === 'ready').length, 1);
  assert.match(result.stderr, /The brief for two could not be rewritten; keeping it: /);

  const down = run('refine-rejected-image-prompts.mjs', [rejectedPath, join(paths.root, 'down.json'), join(paths.root, 'down-work')],
    { FAKE_DOWN: '1' });
  assert.notEqual(down.status, 0);
  assert.equal(existsSync(join(paths.root, 'down.json')), false);
});

test('the quality pass finishes a chunk that holds an image the reviewer cannot judge', t => {
  const { paths, run } = imageSetup(t, {
    one: 'A harbor at dawn.', two: 'A poison song lyric scene.', three: 'A pier, reject me.',
  });
  const output = join(paths.root, 'refined-round-01.json');
  const result = run('stream-image-quality-pass.mjs', [paths.targets, paths.candidates, paths.images, paths.work, output, '1', '8']);
  assert.equal(result.status, 0, result.stderr);
  const refined: Target[] = JSON.parse(readFileSync(output, 'utf8')).targets;
  assert.deepEqual(refined.map(target => target.imageId), ['two', 'three']);
  assert.equal(refined[0].promptRefinement, 'unchanged: the prompt editor could not rewrite this brief');
  assert.equal(readFileSync(join(paths.images, 'one.webp'), 'utf8'), 'candidate for one');
  assert.match(result.stderr, /quality pass complete: accepted=1, rejected=2/);
});
