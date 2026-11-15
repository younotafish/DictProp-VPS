import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Pushes a commit from a second clone, as a deploy does, so vps/main moves ahead of the checkout.
function pushElsewhere(root: string, remote: string, path: string, content: string): string {
  const other = join(root, 'other');
  if (existsSync(other)) git(other, 'pull', '--quiet', '--ff-only');
  else git(root, 'clone', '--quiet', remote, other);
  write(other, path, content);
  git(other, 'add', path);
  git(other, 'commit', '--quiet', '-m', `change ${path}`);
  git(other, 'push', '--quiet', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
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

test('a checkout ahead of vps/main or diverged from it is refused and left where it is', t => {
  const { root, remote, work } = setup(t);
  write(work, 'notes.md', 'local commit\n');
  git(work, 'commit', '--quiet', '-am', 'local');
  const local = git(work, 'rev-parse', 'HEAD');
  const ahead = guard(work);
  assert.equal(ahead.status, 1);
  assert.match(ahead.log, /^HEAD [0-9a-f]{12} has commits that are not on vps\/main \([0-9a-f]{12}\)$/);

  // Another clone moves vps/main on as well, so the two have diverged.
  pushElsewhere(root, remote, 'scripts/offline/stage.sh', 'echo newer\n');
  const diverged = guard(work);
  assert.equal(diverged.status, 1);
  assert.match(diverged.log, /^HEAD [0-9a-f]{12} has commits that are not on vps\/main \([0-9a-f]{12}\)$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), local);
});

test('a clean main behind vps/main is fast-forwarded, and passes only when no code the cycle runs changed', t => {
  const { root, remote, work } = setup(t);
  const start = git(work, 'rev-parse', 'HEAD');

  // A push that leaves the cycle's code alone: main moves to it and the cycle carries on.
  const docs = pushElsewhere(root, remote, 'notes.md', 'newer notes\n');
  const passed = guard(work);
  assert.equal(passed.status, 0, passed.log);
  assert.equal(passed.log, `fast-forwarded main from ${start.slice(0, 12)} to vps/main (${docs.slice(0, 12)})`);
  assert.equal(git(work, 'rev-parse', 'HEAD'), docs);
  assert.equal(readFileSync(join(work, 'notes.md'), 'utf8'), 'newer notes\n');

  // A push that changes a script: main moves, but this run started from the old code, so it is refused.
  const code = pushElsewhere(root, remote, 'scripts/offline/stage.sh', 'echo newer\n');
  const refused = guard(work);
  assert.equal(refused.status, 1);
  assert.equal(refused.log, [
    `fast-forwarded main from ${docs.slice(0, 12)} to vps/main (${code.slice(0, 12)})`,
    'the fast-forward changed code the cycle runs; the next cycle runs the updated code',
  ].join('\n'));
  assert.equal(git(work, 'rev-parse', 'HEAD'), code);
  assert.equal(readFileSync(join(work, 'scripts/offline/stage.sh'), 'utf8'), 'echo newer\n');

  // The next run starts from the new code and passes without moving anything.
  const next = guard(work);
  assert.equal(next.status, 0, next.log);
  assert.equal(next.log, '');
});

test('a checkout behind vps/main stays put on another branch, a detached HEAD, or with a local edit', t => {
  const { root, remote, work } = setup(t);
  const start = git(work, 'rev-parse', 'HEAD');
  pushElsewhere(root, remote, 'notes.md', 'newer notes\n');

  git(work, 'checkout', '--quiet', '-b', 'experiment');
  const branch = guard(work);
  assert.equal(branch.status, 1);
  assert.match(branch.log, /^HEAD [0-9a-f]{12} is behind vps\/main \([0-9a-f]{12}\) on branch experiment, not on main; fast-forward it to vps\/main$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), start);

  git(work, 'checkout', '--quiet', '--detach', 'main');
  const detached = guard(work);
  assert.equal(detached.status, 1);
  assert.match(detached.log, /is behind vps\/main \([0-9a-f]{12}\) on a detached HEAD, not on main; fast-forward it to vps\/main$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), start);

  // Back on main, an edit to code the cycle runs is refused before anything moves.
  git(work, 'checkout', '--quiet', 'main');
  write(work, 'scripts/offline/stage.sh', 'echo unreviewed\n');
  const dirty = guard(work);
  assert.equal(dirty.status, 1);
  assert.match(dirty.log, /^uncommitted changes to code the cycle runs: scripts\/offline\/stage\.sh$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), start);
  git(work, 'checkout', '--', 'scripts/offline/stage.sh');

  // An edit elsewhere that the fast-forward would overwrite stops the merge, and the edit survives.
  write(work, 'notes.md', 'local notes\n');
  const blocked = guard(work);
  assert.equal(blocked.status, 1);
  assert.match(blocked.log, /^could not fast-forward main from [0-9a-f]{12} to vps\/main \([0-9a-f]{12}\): .*notes\.md.*; fast-forward it to vps\/main$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), start);
  assert.equal(readFileSync(join(work, 'notes.md'), 'utf8'), 'local notes\n');
  assert.equal(git(work, 'rev-parse', 'main'), start);
  assert.equal(git(work, 'rev-parse', 'experiment'), start);
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

// Runs the cycle in the checkout. It finds no inputs, so once past the guard it stops at its next check.
function runCycle(root: string, work: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', ['scripts/offline/run-incremental-example-enrichment.sh', join(root, 'cycle')], {
    cwd: work,
    encoding: 'utf8',
    env: { ...gitEnv, GH_BIN: join(root, 'no-gh'), SENTENCE_BRIDGE_KEY_FILE: join(root, 'no-key'), ...env },
    timeout: 60_000,
  });
}

test('the cycle exits 75 on an unvetted checkout before doing anything else, and releases its lock', { skip: !hasShlock }, t => {
  const { root, work } = setup(t);
  const cycleRoot = join(root, 'cycle');
  const run = (env: Record<string, string> = {}) => runCycle(root, work, env);

  write(work, 'scripts/offline/stage.sh', 'echo unreviewed\n');
  const refused = run();
  assert.equal(refused.status, 75, refused.stderr);
  assert.match(refused.stdout, /uncommitted changes to code the cycle runs: scripts\/offline\/stage\.sh/);
  assert.match(refused.stdout, /refusing to run code that differs from vps\/main; exiting 75/);
  assert.equal(existsSync(join(cycleRoot, '.cycle.lock')), false);

  // Vetted again, the cycle gets past the guard and stops at its next check instead. The publishers it
  // would start inherit its deadline, capped at five hours.
  git(work, 'checkout', '--', 'scripts/offline/stage.sh');
  const vetted = run({ PUBLISH_DEADLINE_SECONDS: '86400' });
  assert.notEqual(vetted.status, 75);
  assert.doesNotMatch(vetted.stdout, /refusing to run/);
  assert.match(vetted.stdout, /PUBLISH_DEADLINE_SECONDS=86400 would outlast the sweep, .*; capping it at 18000s/);
  assert.match(`${vetted.stdout}${vetted.stderr}`, /Required incremental enrichment input is missing|deferring this cycle/);
  assert.equal(existsSync(join(cycleRoot, '.cycle.lock')), false);
});

test('the cycle moves main up to a newer vps/main, and exits 75 when that changed its own code', { skip: !hasShlock }, t => {
  const { root, remote, work } = setup(t);
  const code = pushElsewhere(root, remote, 'scripts/offline/stage.sh', 'echo newer\n');
  const refused = runCycle(root, work);
  assert.equal(refused.status, 75, refused.stderr);
  assert.match(refused.stdout, /fast-forwarded main from [0-9a-f]{12} to vps\/main \([0-9a-f]{12}\)/);
  assert.match(refused.stdout, /the fast-forward changed code the cycle runs; the next cycle runs the updated code/);
  assert.match(refused.stdout, /refusing to run code that differs from vps\/main; exiting 75/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), code);
  assert.equal(existsSync(join(root, 'cycle', '.cycle.lock')), false);

  // A push that leaves the cycle's code alone is taken in stride: main moves and the cycle carries on.
  const docs = pushElsewhere(root, remote, 'notes.md', 'newer notes\n');
  const carried = runCycle(root, work);
  assert.notEqual(carried.status, 75);
  assert.match(carried.stdout, /fast-forwarded main from [0-9a-f]{12} to vps\/main \([0-9a-f]{12}\)/);
  assert.doesNotMatch(carried.stdout, /refusing to run/);
  assert.match(`${carried.stdout}${carried.stderr}`, /Required incremental enrichment input is missing|deferring this cycle/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), docs);
});
