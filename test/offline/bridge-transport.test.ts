import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const offlineDir = fileURLToPath(new URL('../../scripts/offline/', import.meta.url));
const tag = 'example-enrichments-wave-0007-20261001T120000Z';

// Records how vps-ssh.sh called it and what it was sent, then answers like the VPS would.
const fakeSsh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = name => args.find((value, index) => args[index - 1] === '-o' && value.startsWith(name + '='))?.slice(name.length + 1);
const key = args[args.indexOf('-i') + 1];
const knownHosts = option('UserKnownHostsFile');
const mode = file => (fs.statSync(file).mode & 0o777).toString(8);
fs.writeFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({
  args,
  key: fs.readFileSync(key, 'utf8'),
  keyMode: mode(key),
  knownHosts: fs.readFileSync(knownHosts, 'utf8'),
  knownHostsMode: mode(knownHosts),
  dirMode: mode(path.dirname(key)),
}));
fs.writeFileSync(process.env.FAKE_SSH_STDIN, fs.readFileSync(0));
if (process.env.FAKE_SSH_OUTPUT) process.stdout.write(fs.readFileSync(process.env.FAKE_SSH_OUTPUT));
process.exitCode = Number(process.env.FAKE_SSH_STATUS || 0);
`;

// Serves release assets and run artifacts from directories, and logs every call.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === 'release' && args[1] === 'download') {
  const source = path.join(process.env.FAKE_RELEASES, args[2], value('--pattern'));
  if (!fs.existsSync(source)) process.exit(1);
  fs.copyFileSync(source, path.join(value('--dir'), value('--pattern')));
} else if (args[0] === 'run' && args[1] === 'download') {
  const source = path.join(process.env.FAKE_ARTIFACTS, args[2], value('-n'));
  if (!fs.existsSync(source)) process.exit(1);
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(value('-D'), name));
} else if (args[0] === 'api' && /\\/actions\\/runs\\/\\d+\\/artifacts$/.test(args[1] || '')) {
  process.stdout.write('9001\\n');
} else if (!(args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE')) {
  process.exit(64);
}
`;

// GNU timeout as the runners have it (macOS has none): logs its limit, and stands for an attempt that
// stalled, exiting 124 without running the command, for as many calls as FAKE_TIMEOUT_STALLS says.
const fakeTimeout = `#!/bin/sh
echo "$1" >> "$FAKE_TIMEOUT_LOG"
if [ "$(wc -l < "$FAKE_TIMEOUT_LOG")" -le "\${FAKE_TIMEOUT_STALLS:-0}" ]; then exit 124; fi
shift
exec "$@"
`;

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = (...parts: string[]) => join(root, ...parts);
  for (const dir of ['bin', 'runner-temp', 'tmp', 'releases', 'artifacts']) mkdirSync(path(dir));
  writeFileSync(path('bin/ssh'), fakeSsh);
  writeFileSync(path('bin/gh'), fakeGh);
  writeFileSync(path('bin/timeout'), fakeTimeout);
  // Retries go on at once.
  writeFileSync(path('bin/sleep'), '#!/bin/sh\nexit 0\n');
  for (const fake of ['ssh', 'gh', 'timeout', 'sleep']) chmodSync(path('bin', fake), 0o755);
  writeFileSync(path('key'), 'test-bridge-key\nignored second line\n');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${path('bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
    GITHUB_REPOSITORY: 'owner/repo',
    RUNNER_TEMP: path('runner-temp'),
    TMPDIR: path('tmp'),
    GH_BIN: path('bin/gh'),
    SENTENCE_BRIDGE_KEY: 'test-bridge-key',
    SENTENCE_BRIDGE_KEY_FILE: path('key'),
    VPS_SSH_KEY: 'fake private key',
    VPS_KNOWN_HOSTS: '107.152.47.101 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA',
    FAKE_SSH_LOG: path('ssh.json'),
    FAKE_SSH_STDIN: path('ssh-stdin'),
    FAKE_GH_LOG: path('gh.log'),
    FAKE_RELEASES: path('releases'),
    FAKE_ARTIFACTS: path('artifacts'),
    FAKE_TIMEOUT_LOG: path('timeout.log'),
  };
  for (const name of ['FAKE_SSH_OUTPUT', 'FAKE_SSH_STATUS', 'FAKE_TIMEOUT_STALLS', 'GITHUB_RUN_ID', 'RELEASE_TAG', 'REMOTE_SCRIPT']) {
    delete env[name];
  }
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('/bin/bash', [join(offlineDir, script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  const encrypt = (input: Buffer, purpose: string, out: string) => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(path('plain'), input);
    const result = spawnSync(process.execPath, [
      join(offlineDir, 'bridge-crypto.mjs'), 'encrypt', '--key-file', path('key'), '--purpose', purpose,
      '--in', path('plain'), '--out', out,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    rmSync(path('plain'));
  };
  const ghCalls = () => existsSync(path('gh.log'))
    ? readFileSync(path('gh.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    : [];
  return { root, path, run, encrypt, ghCalls };
}

test('an import decrypts its asset for its own operation and tag, and the VPS receives exactly the bundle', t => {
  const { path, run, encrypt, ghCalls } = setup(t);
  // Larger than a pipe buffer, so the bundle has to stream.
  const bundle = randomBytes(300_000);
  encrypt(bundle, `import:enrichment-import:${tag}`, path('releases', tag, 'sentence-enrichments.enc'));

  const result = run('bridge-import.sh', ['enrichment-import', 'sentence-enrichments.enc'], {
    RELEASE_TAG: tag,
    REMOTE_SCRIPT: 'tar -xz -C /tmp/sentence-enrichments <&3',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(path('ssh-stdin')).equals(bundle));
  assert.match(result.stdout, /^sentence-enrichments\.enc: \d+ encrypted bytes, sha256 [0-9a-f]{64}\n$/);
  assert.deepEqual(ghCalls(), [[
    'release', 'download', tag, '--repo', 'owner/repo', '--pattern', 'sentence-enrichments.enc',
    '--dir', ghCalls()[0][8], '--clobber',
  ]]);

  const ssh = JSON.parse(readFileSync(path('ssh.json'), 'utf8'));
  assert.deepEqual(ssh.args.slice(0, 3), ['-F', '/dev/null', '-i']);
  for (const option of ['IdentitiesOnly=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null']) {
    assert.ok(ssh.args.some((value: string, index: number) => value === option && ssh.args[index - 1] === '-o'), option);
  }
  assert.deepEqual(ssh.args.slice(-2), ['root@107.152.47.101', 'tar -xz -C /tmp/sentence-enrichments <&3']);
  assert.equal(ssh.key, 'fake private key\n');
  assert.equal(ssh.knownHosts, '107.152.47.101 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA\n');
  assert.deepEqual([ssh.dirMode, ssh.keyMode, ssh.knownHostsMode], ['700', '600', '600']);
  // The decrypted bundle, the key and the known hosts are all gone.
  assert.deepEqual(readdirSync(path('runner-temp')), []);
});

test('a download attempt that stalls is stopped after ten minutes and retried, and five end the import', t => {
  const { path, run, encrypt, ghCalls } = setup(t);
  encrypt(Buffer.from('bundle'), `import:image-import:${tag}`, path('releases', tag, 'offline-images.enc'));
  const attempt = (stalls: string) => run('bridge-import.sh', ['image-import', 'offline-images.enc'], {
    RELEASE_TAG: tag,
    REMOTE_SCRIPT: 'import',
    FAKE_TIMEOUT_STALLS: stalls,
  });

  const retried = attempt('1');
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stderr, /Download attempt 1 of offline-images\.enc timed out after 600s/);
  assert.deepEqual(readFileSync(path('timeout.log'), 'utf8').trim().split('\n'), ['600', '600']);
  assert.equal(ghCalls().length, 1);
  assert.equal(readFileSync(path('ssh-stdin'), 'utf8'), 'bundle');
  assert.deepEqual(readdirSync(path('runner-temp')), []);

  rmSync(path('timeout.log'));
  rmSync(path('ssh.json'));
  const stalled = attempt('5');
  assert.equal(stalled.status, 1);
  assert.match(stalled.stderr, /Download attempt 5 of offline-images\.enc timed out after 600s/);
  assert.match(stalled.stderr, /Could not download offline-images\.enc from release/);
  assert.equal(readFileSync(path('timeout.log'), 'utf8').trim().split('\n').length, 5);
  assert.equal(existsSync(path('ssh.json')), false);
  assert.deepEqual(readdirSync(path('runner-temp')), []);
});

test('an asset made for another import, another release or altered in transit never reaches the VPS', t => {
  const { path, run, encrypt } = setup(t);
  const asset = path('releases', tag, 'sentence-enrichments.enc');
  const attempt = () => run('bridge-import.sh', ['enrichment-import', 'sentence-enrichments.enc'], {
    RELEASE_TAG: tag,
    REMOTE_SCRIPT: 'import',
  });
  for (const purpose of [`import:image-import:${tag}`, 'import:enrichment-import:example-enrichments-wave-0006-20261001T000000Z']) {
    encrypt(Buffer.from('bundle'), purpose, asset);
    const refused = attempt();
    assert.notEqual(refused.status, 0, purpose);
    assert.match(refused.stderr, /authenticat|decrypt/i, purpose);
  }
  encrypt(randomBytes(4_000), `import:enrichment-import:${tag}`, asset);
  const tampered = readFileSync(asset);
  tampered[2_000] ^= 1;
  writeFileSync(asset, tampered);
  assert.notEqual(attempt().status, 0);
  assert.equal(existsSync(path('ssh.json')), false);
  assert.deepEqual(readdirSync(path('runner-temp')), []);
});

test('a failed SSH session fails the import and leaves nothing behind', t => {
  const { path, run, encrypt } = setup(t);
  encrypt(Buffer.from('bundle'), `import:image-import:${tag}`, path('releases', tag, 'offline-images.enc'));
  const result = run('bridge-import.sh', ['image-import', 'offline-images.enc'], {
    RELEASE_TAG: tag,
    REMOTE_SCRIPT: 'import',
    FAKE_SSH_STATUS: '255',
  });
  assert.equal(result.status, 255);
  assert.equal(readFileSync(path('ssh-stdin'), 'utf8'), 'bundle');
  assert.deepEqual(readdirSync(path('runner-temp')), []);
});

test('an export reaches this Mac only as its encrypted artifact, which is then deleted with the run log', t => {
  const { path, run, ghCalls } = setup(t);
  const records = JSON.stringify({ version: 1, items: [{ id: 'one', text: 'A private sentence.' }] });
  writeFileSync(path('export.gz'), gzipSync(records));
  const blob = path('runner-temp', 'sentence-export.dpb');
  const exported = run('bridge-export.sh', ['sentence-export', blob], {
    GITHUB_RUN_ID: '4242',
    REMOTE_SCRIPT: 'export',
    FAKE_SSH_OUTPUT: path('export.gz'),
  });
  assert.equal(exported.status, 0, exported.stderr);
  // Only the blob's size and hash reach the log, and the blob holds no plaintext.
  assert.match(exported.stdout, /^sentence-export: \d+ encrypted bytes, sha256 [0-9a-f]{64}\n$/);
  assert.match(exported.stderr, /^bridge-crypto: encrypted \d+ bytes for sentence-export:4242\n$/);
  const encrypted = readFileSync(blob);
  assert.equal(encrypted.subarray(0, 4).toString('ascii'), 'DPB1');
  assert.equal(encrypted.includes(readFileSync(path('export.gz'))), false);
  assert.equal(readFileSync(path('ssh-stdin')).length, 0);

  mkdirSync(path('artifacts', '4242', 'sentence-export'), { recursive: true });
  copyFileSync(blob, path('artifacts', '4242', 'sentence-export', 'sentence-export.dpb'));
  mkdirSync(path('local'));
  const output = path('local', 'sentence-export.json');
  const fetched = run('fetch-workflow-export.sh', ['4242', 'sentence-export', output]);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(readFileSync(output, 'utf8'), records);
  assert.deepEqual(readdirSync(path('local')), ['sentence-export.json']);
  assert.deepEqual(readdirSync(path('tmp')), []);
  const calls = ghCalls();
  assert.deepEqual(calls[0].slice(0, 6), ['run', 'download', '4242', '--repo', 'owner/repo', '-n']);
  assert.deepEqual(calls.slice(-2), [
    ['api', '-X', 'DELETE', 'repos/owner/repo/actions/artifacts/9001'],
    ['api', '-X', 'DELETE', 'repos/owner/repo/actions/runs/4242/logs'],
  ]);
  assert.match(fetched.stdout, /deleted artifact 9001 \(sentence-export\) of run 4242/);
  assert.match(fetched.stdout, /deleted the logs of run 4242/);
});

test('an export from another run or artifact, or one that is not JSON, is refused and nothing is deleted', t => {
  const { path, run, encrypt, ghCalls } = setup(t);
  const records = gzipSync('{"version":1,"items":[]}');
  const serve = (runId: string, purpose: string, plain: Buffer = records) =>
    encrypt(plain, purpose, path('artifacts', runId, 'sentence-export', 'sentence-export.dpb'));
  serve('4243', 'sentence-export:4242');
  serve('4244', 'corpus-export:4244');
  serve('4245', 'sentence-export:4245', gzipSync('not json'));
  serve('4246', 'sentence-export:4246');
  copyFileSync(path('artifacts', '4246', 'sentence-export', 'sentence-export.dpb'), path('artifacts', '4246', 'sentence-export', 'second.dpb'));
  mkdirSync(path('local'));
  const output = path('local', 'sentence-export.json');
  writeFileSync(output, 'previous export\n');

  for (const runId of ['4243', '4244', '4245', '4246']) {
    const refused = run('fetch-workflow-export.sh', [runId, 'sentence-export', output]);
    assert.notEqual(refused.status, 0, runId);
    assert.equal(readFileSync(output, 'utf8'), 'previous export\n', runId);
    assert.deepEqual(readdirSync(path('local')), ['sentence-export.json'], runId);
  }
  assert.deepEqual(ghCalls().filter(call => call.includes('DELETE')), []);
  assert.deepEqual(readdirSync(path('tmp')), []);
  assert.equal(run('fetch-workflow-export.sh', ['42x', 'sentence-export', output]).status, 2);
  assert.equal(run('fetch-workflow-export.sh', ['4242', 'other-export', output]).status, 2);
});

test('an export whose SSH session fails leaves no blob to upload', t => {
  const { path, run } = setup(t);
  writeFileSync(path('partial.gz'), gzipSync('{"version":1,"items":[').subarray(0, 12));
  const blob = path('runner-temp', 'corpus-export.dpb');
  const result = run('bridge-export.sh', ['corpus-export', blob], {
    GITHUB_RUN_ID: '4242',
    REMOTE_SCRIPT: 'export',
    FAKE_SSH_OUTPUT: path('partial.gz'),
    FAKE_SSH_STATUS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(blob), false);
  assert.deepEqual(readdirSync(path('runner-temp')), []);
});
