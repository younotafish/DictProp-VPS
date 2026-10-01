import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const offlineDir = fileURLToPath(new URL('../../scripts/offline/', import.meta.url));
const hasShlock = spawnSync('/bin/sh', ['-c', 'command -v shlock'], { encoding: 'utf8' }).status === 0;

// The user's own git configuration (signing, hooks, default branch) must not reach these repositories.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Cycle Test',
  GIT_AUTHOR_EMAIL: 'cycle@example.com',
  GIT_COMMITTER_NAME: 'Cycle Test',
  GIT_COMMITTER_EMAIL: 'cycle@example.com',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// A checkout whose main is pushed to a bare "vps" remote, like the cycle's tree after a deploy.
function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cycle-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'vps.git');
  const work = join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--quiet', '--initial-branch=main', work);
  write(work, 'scripts/offline/stage.sh', 'echo stage\n');
  write(work, 'server/src/scripts/source.ts', 'export {};\n');
  write(work, 'server/package.json', '{}\n');
  write(work, 'package.json', '{}\n');
  write(work, '.gh', 'binary\n');
  write(work, 'notes.md', 'notes\n');
  for (const file of ['deadline.sh', 'vetted-checkout.sh', 'run-incremental-example-enrichment.sh']) {
    copyFileSync(join(offlineDir, file), join(work, 'scripts/offline', file));
  }
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'initial');
  git(work, 'remote', 'add', 'vps', remote);
  git(work, 'push', '--quiet', 'vps', 'main');
  return { root, remote, work };
}

function guard(work: string) {
  const result = spawnSync('/bin/bash', ['-c', [
    'set -euo pipefail',
    'log() { printf "%s\\n" "$*"; }',
    '. scripts/offline/deadline.sh',
    '. scripts/offline/vetted-checkout.sh',
    'status=0; require_vetted_checkout || status=$?',
    'echo "status=$status"',
  ].join('\n')], { cwd: work, encoding: 'utf8', env: gitEnv, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  return { status: Number(lines.pop()?.replace('status=', '')), log: lines.join('\n'), stderr: result.stderr };
}

test('a clean checkout at vps/main passes, untracked files and changes outside the code included', t => {
  const { work } = setup(t);
  assert.equal(guard(work).status, 0);
  write(work, 'scripts/offline/scratch.mjs', 'untracked\n');
  write(work, 'notes.md', 'edited notes\n');
  const result = guard(work);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.log, '');
});

test('uncommitted or staged changes to code the cycle runs are refused', t => {
  const { work } = setup(t);
  for (const path of ['scripts/offline/stage.sh', 'server/src/scripts/source.ts', 'server/package.json', 'package.json', '.gh']) {
    write(work, path, 'changed\n');
    const result = guard(work);
    assert.equal(result.status, 1, path);
    assert.match(result.log, new RegExp(`uncommitted changes to code the cycle runs: .*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    git(work, 'checkout', '--', path);
  }
  write(work, 'server/src/scripts/source.ts', 'staged\n');
  git(work, 'add', 'server/src/scripts/source.ts');
  assert.equal(guard(work).status, 1);
  git(work, 'reset', '--quiet', '--hard');
  git(work, 'rm', '--quiet', 'scripts/offline/stage.sh');
  assert.equal(guard(work).status, 1);
});

test('a commit that is not on vps/main is refused, and an older commit of vps/main passes', t => {
  const { root, remote, work } = setup(t);
  write(work, 'notes.md', 'local commit\n');
  git(work, 'commit', '--quiet', '-am', 'local');
  const local = guard(work);
  assert.equal(local.status, 1);
  assert.match(local.log, /HEAD [0-9a-f]{12} has commits that are not on vps\/main \([0-9a-f]{12}\)/);

  // Another clone moves vps/main ahead; the guard fetches it, and HEAD is then one of its ancestors.
  git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
  const other = join(root, 'other');
  git(root, 'clone', '--quiet', remote, other);
  write(other, 'scripts/offline/stage.sh', 'echo newer\n');
  git(other, 'commit', '--quiet', '-am', 'newer');
  git(other, 'push', '--quiet', 'origin', 'main');
  assert.equal(guard(work).status, 0);
  assert.equal(git(work, 'rev-parse', 'refs/remotes/vps/main'), git(other, 'rev-parse', 'HEAD'));
});

test('a failed fetch falls back to the vps/main fetched last, and no fetched vps/main is refused', t => {
  const { root, work } = setup(t);
  git(work, 'remote', 'set-url', 'vps', join(root, 'missing.git'));
  const fallback = guard(work);
  assert.equal(fallback.status, 0, fallback.log);
  assert.match(fallback.log, /could not fetch vps\/main; checking against the copy fetched last/);

  write(work, 'notes.md', 'local commit\n');
  git(work, 'commit', '--quiet', '-am', 'local');
  assert.equal(guard(work).status, 1);

  git(work, 'update-ref', '-d', 'refs/remotes/vps/main');
  const missing = guard(work);
  assert.equal(missing.status, 1);
  assert.match(missing.log, /no fetched vps\/main to check this checkout against/);
});

test('the cycle exits 75 on an unvetted checkout before doing anything else, and releases its lock', { skip: !hasShlock }, t => {
  const { root, work } = setup(t);
  const cycleRoot = join(root, 'cycle');
  const run = () => spawnSync('/bin/bash', ['scripts/offline/run-incremental-example-enrichment.sh', cycleRoot], {
    cwd: work,
    encoding: 'utf8',
    env: { ...gitEnv, GH_BIN: join(root, 'no-gh'), SENTENCE_BRIDGE_KEY_FILE: join(root, 'no-key') },
    timeout: 60_000,
  });

  write(work, 'scripts/offline/stage.sh', 'echo unreviewed\n');
  const refused = run();
  assert.equal(refused.status, 75, refused.stderr);
  assert.match(refused.stdout, /uncommitted changes to code the cycle runs: scripts\/offline\/stage\.sh/);
  assert.match(refused.stdout, /refusing to run code that is not committed and on vps\/main; exiting 75/);
  assert.equal(existsSync(join(cycleRoot, '.cycle.lock')), false);

  // Vetted again, the cycle gets past the guard and stops at its next check instead.
  git(work, 'checkout', '--', 'scripts/offline/stage.sh');
  const vetted = run();
  assert.notEqual(vetted.status, 75);
  assert.doesNotMatch(vetted.stdout, /refusing to run/);
  assert.match(`${vetted.stdout}${vetted.stderr}`, /Required incremental enrichment input is missing|deferring this cycle/);
  assert.equal(existsSync(join(cycleRoot, '.cycle.lock')), false);
});
