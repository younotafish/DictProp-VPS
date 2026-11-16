import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { REMOTE_SHELL, stub } from './support/deploy.ts';
import { block, entry, jobs, readWorkflow, runs, settings, steps } from './support/workflow.ts';

const workflow = readWorkflow('offsite-backup.yml');
const bridge = readWorkflow('sentence-backfill.yml');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const jobsById = jobs(workflow);
const job = jobsById.get('db-backup') ?? '';
const step = (marker: string): string => {
  const found = steps(job).filter(text => text.includes(marker));
  assert.equal(found.length, 1, marker);
  return found[0];
};
const exportStep = step('- name: Export the encrypted database backup');

test('the backup runs only when dispatched, with a read-only token, in the queue of jobs that write production', () => {
  assert.match(workflow, /^name: Off-site Database Backup$/m);
  assert.deepEqual(settings(entry(workflow, 'on', 0)), ['workflow_dispatch:']);
  assert.deepEqual(settings(entry(workflow, 'permissions', 0)), ['contents: read']);
  assert.deepEqual([...jobsById.keys()], ['db-backup']);
  assert.doesNotMatch(job, /^ {4}permissions:/m);
  // The Mac finds the job's artifact by this name, and the bridge-crypto purpose is db-backup:<run id>.
  assert.match(job, /^ {4}name: db-backup$/m);
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(job, /^ {4}timeout-minutes: 60$/m);
  assert.match(job, /^ {4}concurrency:\n {6}group: dictprop-production\n {6}cancel-in-progress: false$/m);
  assert.match(exportStep, /^ {8}timeout-minutes: 50$/m);
});

test('its actions are the bridge workflow\'s pins, and its checkout is sparse and keeps no token', () => {
  const pins = (text: string) => new Set([...text.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map(match => match[1]));
  const used = pins(workflow);
  assert.equal(used.size, 3);
  for (const ref of used) assert.ok(pins(bridge).has(ref), ref);

  const checkout = step('uses: actions/checkout@');
  assert.match(checkout, /^ {10}persist-credentials: false$/m);
  assert.deepEqual(block(checkout, 'sparse-checkout').trim().split('\n').sort(), [
    'scripts/offline/bridge-crypto.mjs', 'scripts/offline/bridge-export.sh', 'scripts/offline/vps-ssh.sh',
  ]);
  assert.match(checkout, /^ {10}sparse-checkout-cone-mode: false$/m);
  const node = step('uses: actions/setup-node@');
  assert.match(node, /^ {10}node-version: 22$/m);
  assert.match(node, /^ {10}package-manager-cache: false$/m);
});

test('the database leaves the runner only as an encrypted artifact that expires within a day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offsite-step-'));
  try {
    mkdirSync(join(dir, 'scripts', 'offline'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'offline', 'bridge-export.sh'),
      'printf "%s\\n" "$*" > args\nprintf "%s" "$REMOTE_SCRIPT" > remote\n');
    const [run, ...others] = runs(exportStep);
    assert.deepEqual(others, []);
    // GitHub runs a step without `shell:` in bash -e.
    const result = spawnSync('bash', ['-e', '-c', run], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: '/runner-temp', REMOTE_SCRIPT: block(exportStep, 'REMOTE_SCRIPT') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, 'args'), 'utf8'), 'db-backup /runner-temp/db-backup.dpb\n');
    assert.equal(readFileSync(join(dir, 'remote'), 'utf8'), block(exportStep, 'REMOTE_SCRIPT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const upload = step('uses: actions/upload-artifact@');
  assert.deepEqual(settings(entry(upload, 'with', 8)), [
    'name: db-backup',
    'path: ${{ runner.temp }}/db-backup.dpb',
    'if-no-files-found: error',
    'retention-days: 1',
    'compression-level: 0',
  ]);
  assert.equal([...workflow.matchAll(/uses: actions\/upload-artifact@/g)].length, 1);
});

test('it reaches the VPS only through the bridge\'s pinned channel and prints no secret', () => {
  assert.equal(block(workflow, 'VPS_KNOWN_HOSTS'), block(bridge, 'VPS_KNOWN_HOSTS'));
  assert.doesNotMatch(workflow, /openssl|base64|appleboy/);
  for (const value of runs(workflow)) assert.doesNotMatch(value, /(?:^|[\s;&|(])(?:ssh|scp|rsync|sftp)\s/, value);
  assert.deepEqual([...workflow.matchAll(/^\s+(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)].map(match => [match[1], match[2]]), [
    ['SENTENCE_BRIDGE_KEY', 'SENTENCE_BRIDGE_KEY'],
    ['VPS_SSH_KEY', 'VPS_SSH_KEY'],
  ]);
  assert.equal(workflow.match(/secrets\./g)?.length, 2);
});

const MANIFEST = (copy: string) => JSON.stringify({ version: 1, copy, bytes: 12, pageSize: 4096, pageCount: 3, counts: {}, createdAt: '2026-11-16T00:00:00.000Z' });

/**
 * Runs the remote script as the VPS would, in root's login shell there, zsh (without this machine's startup files),
 * with docker stood in for and production's paths moved under a temporary root, and returns what it streamed.
 */
function runRemote(manifest: string, { dockerStatus = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'offsite-remote-'));
  try {
    const bin = join(root, 'bin');
    const scratch = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(scratch);
    mkdirSync(join(root, 'vps', 'data', 'backups'), { recursive: true });
    writeFileSync(join(root, 'vps', 'data', 'backups', 'pre-offsite-20261116T000000Z.db'), 'SQLite copy\n');
    writeFileSync(join(root, 'Caddyfile'), 'dictprop.online, www.dictprop.online {\n\treverse_proxy 127.0.0.1:3000\n}\n');
    stub(bin, 'docker', `
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$*" != "compose exec -T app nice -n 19 node server/dist/scripts/prepare-db-backup.js" ]; then echo "unexpected docker $*" >&2; exit 97; fi
printf '%s\\n' "$FAKE_MANIFEST"
exit "$FAKE_STATUS"`);
    const script = block(exportStep, 'REMOTE_SCRIPT')
      .replaceAll('/opt/dictprop-vps', join(root, 'vps'))
      .replaceAll('/etc/caddy/Caddyfile', join(root, 'Caddyfile'));
    const log = join(root, 'docker.log');
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', script], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        TMPDIR: scratch,
        FAKE_DOCKER_LOG: log,
        FAKE_MANIFEST: manifest,
        FAKE_STATUS: String(dockerStatus),
      },
      timeout: 30_000,
    });
    let members: string[] = [];
    const files: Record<string, string> = {};
    if (result.status === 0) {
      const archive = gunzipSync(result.stdout);
      members = spawnSync('tar', ['-tf', '-'], { input: archive, encoding: 'utf8' }).stdout.trim().split('\n');
      const out = join(root, 'out');
      mkdirSync(out);
      assert.equal(spawnSync('tar', ['-xf', '-', '-C', out], { input: archive }).status, 0);
      for (const name of readdirSync(out)) files[name] = readFileSync(join(out, name), 'utf8');
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr.toString(),
      docker: readFileSync(log, 'utf8').trim().split('\n'),
      members,
      files,
      // What the script left in its temporary directory once it ended.
      leftovers: readdirSync(scratch),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the remote script streams the manifest, the live Caddyfile and the slot\'s copy as one gzipped tar', { skip: !hasPython && 'python3 is not installed' }, () => {
  const copy = 'pre-offsite-20261116T000000Z.db';
  const streamed = runRemote(MANIFEST(copy));
  assert.equal(streamed.status, 0, streamed.stderr);
  assert.deepEqual(streamed.docker, ['compose exec -T app nice -n 19 node server/dist/scripts/prepare-db-backup.js']);
  assert.deepEqual(streamed.members, ['manifest.json', 'Caddyfile', copy]);
  assert.deepEqual(streamed.files, {
    'manifest.json': `${MANIFEST(copy)}\n`,
    Caddyfile: 'dictprop.online, www.dictprop.online {\n\treverse_proxy 127.0.0.1:3000\n}\n',
    [copy]: 'SQLite copy\n',
  });
  assert.deepEqual(streamed.leftovers, []);
});

test('the remote script streams nothing when the copy is not one the slot holds, or the manifest fails', { skip: !hasPython && 'python3 is not installed' }, () => {
  for (const copy of ['../dictprop.db', 'pre-offsite/../../etc/shadow.db', 'dictprop.db-wal', 'other-20261116T000000Z.db']) {
    const refused = runRemote(MANIFEST(copy));
    assert.notEqual(refused.status, 0, copy);
    assert.equal(refused.stdout.length, 0, copy);
    assert.match(refused.stderr, /unexpected backup name/, copy);
    assert.deepEqual(refused.leftovers, [], copy);
  }
  const failed = runRemote('', { dockerStatus: 3 });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout.length, 0);
  assert.deepEqual(failed.leftovers, []);
});
