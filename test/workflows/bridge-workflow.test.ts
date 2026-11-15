import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRepoFile } from '../support/paths.ts';
import { block, entry, jobs, readWorkflow, runs, settings, steps } from './support/workflow.ts';

const workflow = readWorkflow('sentence-backfill.yml');

// Each import operation: the release asset it decrypts, where its bundle unpacks in the container, the server script
// that imports it and the file that script reads, whether it runs at lower priority, whether it needs a free-disk
// floor, its job and step time limits, and the publishers that dispatch it.
const imports = [
  { op: 'import', asset: 'sentence-backfill.enc', bundle: '/tmp/sentence-backfill', importer: 'import-sentence-backfill.js', input: 'manifest.json', nice: true, floor: false, minutes: [75, 60], dispatchers: ['dispatch-staged-saved-sentence-analyses.sh'] },
  { op: 'enrichment-import', asset: 'sentence-enrichments.enc', bundle: '/tmp/sentence-enrichments', importer: 'import-sentence-enrichments.js', input: 'manifest.json', nice: true, floor: true, minutes: [75, 60], dispatchers: ['dispatch-staged-example-analyses.sh', 'dispatch-staged-example-enrichments.sh'] },
  { op: 'essay-import', asset: 'private-essay-catalog.enc', bundle: '/tmp/private-essay-catalog', importer: 'import-private-essay-catalog.js', input: 'catalog.json', nice: false, floor: false, minutes: [30, 15], dispatchers: ['publish-private-essay-catalog.sh'] },
  { op: 'corpus-import', asset: 'corpus-audit.enc', bundle: '/tmp/corpus-audit', importer: 'import-corpus-audit.js', input: 'manifest.json', nice: false, floor: false, minutes: [90, 60], dispatchers: ['dispatch-staged-corpus-audit.sh'] },
  { op: 'image-import', asset: 'offline-images.enc', bundle: '/tmp/offline-images', importer: 'import-offline-images.js', input: 'manifest.json', nice: true, floor: false, minutes: [75, 60], dispatchers: ['dispatch-staged-offline-images.sh'] },
  { op: 'audio-import', asset: 'offline-audio.enc', bundle: '/tmp/offline-audio', importer: 'import-offline-tts.js', input: 'manifest.json', nice: true, floor: true, minutes: [75, 60], dispatchers: ['dispatch-staged-offline-audio.sh'] },
];
const exports = [
  { op: 'export', artifact: 'sentence-export', exporter: 'export-sentence-backfill.js' },
  { op: 'corpus-export', artifact: 'corpus-export', exporter: 'export-corpus-audit.js' },
];

const jobsById = jobs(workflow);
const job = (id: string) => {
  const text = jobsById.get(id);
  assert.ok(text, `job ${id}`);
  return text;
};

/** The one step of a job that runs a script. */
function scriptStep(id: string): string {
  const [step, ...others] = steps(job(id)).filter(text => runs(text).length > 0 && !/^\s+- name: Validate /.test(text));
  assert.ok(step && others.length === 0, `${id} has one script step`);
  return step;
}

/**
 * Evaluates a job's `if:` or a time limit for one operation. The workflow uses only `inputs.operation == '<value>'`,
 * `endsWith(inputs.operation, '<suffix>')`, `<test> && <number>`, `||` and plain numbers; anything else throws.
 */
function evaluate(expression: string, operation: string): boolean | number {
  const test = (term: string): boolean => {
    const equals = /^inputs\.operation == '([\w-]+)'$/.exec(term);
    if (equals) return operation === equals[1];
    const suffix = /^endsWith\(inputs\.operation, '([\w-]+)'\)$/.exec(term);
    if (suffix) return operation.endsWith(suffix[1]);
    throw new Error(`unexpected term ${term}`);
  };
  for (const alternative of expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').split(' || ')) {
    if (/^\d+$/.test(alternative)) return Number(alternative);
    const [condition, value] = alternative.split(' && ');
    if (test(condition)) return value === undefined ? true : Number(value);
  }
  return false;
}

/** What a job's script step hands its bridge script for one operation: the arguments and the remote script. */
function bridgeCall(id: 'import' | 'export', operation: string) {
  const step = scriptStep(id);
  const dir = mkdtempSync(join(tmpdir(), 'bridge-step-'));
  try {
    mkdirSync(join(dir, 'scripts', 'offline'), { recursive: true });
    for (const name of ['bridge-import.sh', 'bridge-export.sh']) {
      writeFileSync(join(dir, 'scripts', 'offline', name), 'printf "%s\\n" "$*" > args\nprintf "%s" "$REMOTE_SCRIPT" > remote\n');
    }
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const key = id === 'import' ? 'IMPORT_SCRIPT' : 'EXPORT_SCRIPT';
    // GitHub runs a step without `shell:` in bash -e.
    const result = spawnSync('bash', ['-e', '-c', runs(step)[0]], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, OPERATION: operation, RUNNER_TEMP: '/runner-temp', GITHUB_OUTPUT: output, [key]: block(step, key) },
    });
    if (result.status !== 0) return { status: result.status, output: result.stderr, args: '', remote: '', outputs: '' };
    return {
      status: result.status,
      output: result.stderr,
      args: readFileSync(join(dir, 'args'), 'utf8').trim(),
      remote: readFileSync(join(dir, 'remote'), 'utf8'),
      outputs: readFileSync(output, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the pinned known hosts hold the key the appleboy steps pin and nothing else', () => {
  const fingerprint = workflow.match(/^ {2}VPS_SSH_FINGERPRINT: (SHA256:[A-Za-z0-9+/]{43})$/m)?.[1];
  assert.ok(fingerprint);
  const entries = block(workflow, 'VPS_KNOWN_HOSTS').trim().split('\n').map(line => line.split(' '));
  assert.deepEqual(entries.map(([host, type]) => [host, type]), [
    ['107.152.47.101', 'ecdsa-sha2-nistp256'],
    ['107.152.47.101', 'ssh-ed25519'],
  ]);
  for (const [, type, key, ...rest] of entries) {
    assert.deepEqual(rest, []);
    // An OpenSSH public key blob starts with its own length-prefixed type name.
    const blob = Buffer.from(key, 'base64');
    assert.equal(blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii'), type);
  }
  const sha256 = (key: string) => `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;
  assert.equal(sha256(entries[0][2]), fingerprint);
  // Read on the VPS on 2026-10-01 together with the ECDSA key; a changed host key must change this too.
  assert.equal(sha256(entries[1][2]), 'SHA256:4XnYH05FNeVqobjiAhpZz/ccjQGsob2nZfXiVkXu+xo');
});

// The publishers and the cycle find their run's job by name, and a group's newest queued job cancels its pending one.
test('every operation runs exactly one job, named after the operation where the bridge looks for it', () => {
  const options = settings(entry(workflow, 'options', 8)).map(option => option.replace(/^- /, ''));
  assert.deepEqual([...options].sort(), [...imports.map(({ op }) => op), ...exports.map(({ op }) => op), 'audit', 'repair', 'repair-apply'].sort());
  const conditions = new Map([...jobsById].map(([id, text]) => [id, /^ {4}if: (.+)$/m.exec(text)?.[1] ?? '']));
  for (const operation of options) {
    const running = [...conditions].filter(([, condition]) => evaluate(condition, operation) === true).map(([id]) => id);
    const expected = imports.some(({ op }) => op === operation) ? 'import'
      : exports.some(({ op }) => op === operation) ? 'export'
        : operation.startsWith('repair') ? 'repair' : 'audit';
    assert.deepEqual(running, [expected], operation);
  }
  for (const id of ['import', 'export']) assert.match(job(id), /^ {4}name: \$\{\{ inputs\.operation \}\}$/m, id);
  assert.match(job('import'), /^ {6}group: dictprop-production$/m);
  assert.match(job('export'), /^ {6}group: dictprop-production-read$/m);
});

test('each import keeps its own time limits', () => {
  const jobLimit = /^ {4}timeout-minutes: (.+)$/m.exec(job('import'))?.[1] ?? '';
  const stepLimit = /^ {8}timeout-minutes: (.+)$/m.exec(scriptStep('import'))?.[1] ?? '';
  for (const { op, minutes } of imports) assert.deepEqual([evaluate(jobLimit, op), evaluate(stepLimit, op)], minutes, op);
  assert.match(job('export'), /^ {4}timeout-minutes: 30$/m);
  assert.match(scriptStep('export'), /^ {8}timeout-minutes: 15$/m);
});

test('exports leave the runner only as an encrypted artifact that expires within a day', () => {
  for (const { op, artifact } of exports) {
    const call = bridgeCall('export', op);
    assert.equal(call.status, 0, `${op}: ${call.output}`);
    assert.equal(call.args, `${artifact} /runner-temp/${artifact}.dpb`, op);
    assert.equal(call.outputs, `artifact=${artifact}\n`, op);
  }
  assert.notEqual(bridgeCall('export', 'import').status, 0, 'an import is not an export');
  const uploads = steps(job('export')).filter(step => step.includes('uses: actions/upload-artifact@'));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /^ {10}name: \$\{\{ steps\.export\.outputs\.artifact \}\}$/m);
  assert.match(uploads[0], /^ {10}path: \$\{\{ runner\.temp \}\}\/\$\{\{ steps\.export\.outputs\.artifact \}\}\.dpb$/m);
  assert.match(uploads[0], /^ {10}if-no-files-found: error$/m);
  assert.match(uploads[0], /^ {10}retention-days: 1$/m);
  assert.match(scriptStep('export'), /^ {8}id: export$/m);
  assert.equal([...workflow.matchAll(/uses: actions\/upload-artifact@/g)].length, 1);
});

test('each import decrypts only its own asset and streams it to its importer', () => {
  const text = job('import');
  assert.match(text, /\[\[ "\$RELEASE_TAG" =~ \^\[A-Za-z0-9\._-\]\{1,200\}\$ \]\]/);
  assert.match(scriptStep('import'), /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(scriptStep('import'), /RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/);
  for (const { op, asset } of imports) {
    const call = bridgeCall('import', op);
    assert.equal(call.status, 0, `${op}: ${call.output}`);
    assert.equal(call.args, `${op} ${asset}`, op);
    // Only the unpacking reads the bundle; everything else runs with standard input closed.
    const closed = call.remote.indexOf('exec 3<&0 < /dev/null');
    assert.ok(closed >= 0 && closed < call.remote.indexOf('docker compose'), op);
    assert.equal(call.remote.match(/<&3/g)?.length, 1, op);
  }
  assert.notEqual(bridgeCall('import', 'corpus-export').status, 0, 'an export is not an import');
});

test('each dispatcher binds its archive to the import job that decrypts it', () => {
  for (const { op, asset, dispatchers } of imports) {
    for (const dispatcher of dispatchers) {
      const script = readRepoFile(`scripts/offline/${dispatcher}`);
      assert.match(script, new RegExp(`ARCHIVE="\\$[A-Z_]+/${asset.replace('.', '\\.')}"`), dispatcher);
      assert.ok(script.includes(`--purpose "import:${op}:$RELEASE_TAG"`), dispatcher);
      assert.match(script, new RegExp(`\\b${asset.replace('.', '\\.')}\\s*\\\\?\\s*${op}\\b`), dispatcher);
    }
  }
});

test('the bridge jobs reach the VPS only through the pinned channel and print no secret material', () => {
  assert.doesNotMatch(workflow, /openssl|base64|_BEGIN|_END|BEGIN_[A-Z]/);
  for (const value of runs(workflow)) {
    assert.doesNotMatch(value, /(?:^|[\s;&|(])(?:ssh|scp|rsync|sftp)\s/, value);
  }
  for (const line of workflow.split('\n').filter(text => text.includes('secrets.SENTENCE_BRIDGE_KEY'))) {
    assert.match(line, /^\s+SENTENCE_BRIDGE_KEY: \$\{\{ secrets\.SENTENCE_BRIDGE_KEY \}\}$/);
  }
  const bridgeJobs = [...jobsById].filter(([, text]) => text.includes('scripts/offline/bridge-'));
  assert.deepEqual(bridgeJobs.map(([id]) => id), ['export', 'import']);
  for (const [id, text] of bridgeJobs) {
    const checkout = block(text, 'sparse-checkout').trim().split('\n').sort();
    assert.deepEqual(checkout, ['scripts/offline/bridge-crypto.mjs', `scripts/offline/bridge-${id}.sh`, 'scripts/offline/vps-ssh.sh'], id);
    assert.match(text, /VPS_SSH_KEY: \$\{\{ secrets\.VPS_SSH_KEY \}\}/, id);
  }
});

// Runs a remote script as the VPS would, in root's login shell there, zsh (without this machine's
// startup files), with docker and df stood in for, and production paths moved under a temporary root.
function runRemote(remote: string, { stdin, env = {} }: { stdin?: string; env?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'vps'));
  mkdirSync(join(root, 'container'));
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ "$1 $2 $3 $4" != "compose exec -T app" ]; then echo "unexpected docker $*" >&2; exit 97; fi
shift 4
case "$1" in
  sh) printf 'unpack\\n' >> "$FAKE_DOCKER_LOG"; exec /bin/sh -c "$3" ;;
  rm) printf 'cleanup %s\\n' "$*" >> "$FAKE_DOCKER_LOG"; exec "$@" ;;
esac
for last in "$@"; do :; done
printf 'run %s stdin=%s\\n' "$*" "$(wc -c | tr -d ' ')" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *server/dist/scripts/export-*) printf '%s' "$FAKE_EXPORT_JSON"; exit "\${FAKE_STATUS:-0}" ;;
esac
cp "$last" "$FAKE_IMPORTED" && exit "\${FAKE_STATUS:-0}"
`);
  writeFileSync(join(bin, 'df'), `#!/bin/bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/vda1 61000000 1000 %s 1%% /\\n' "\${FAKE_AVAILABLE_KB:-50000000}"
`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'df'), 0o755);
  // /tmp first: the temporary root itself may sit under /tmp.
  const script = remote.replaceAll('/tmp/', `${join(root, 'container')}/`).replaceAll('/opt/dictprop-vps', join(root, 'vps'));
  const log = join(root, 'docker.log');
  const imported = join(root, 'imported');
  const result = spawnSync('zsh', ['-f', '-c', script], {
    input: stdin === undefined ? undefined : readFileSync(stdin),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_IMPORTED: imported, ...env },
    timeout: 30_000,
  });
  const output = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr.toString(),
    log: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    imported: existsSync(imported) ? readFileSync(imported, 'utf8') : undefined,
    // What the container's /tmp still holds once the script has ended.
    leftovers: readdirSync(join(root, 'container')),
  };
  rmSync(root, { recursive: true, force: true });
  return output;
}

test('each import unpacks the streamed bundle, imports it with standard input closed, and cleans up', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { op, bundle, importer, input, nice, floor } of imports) {
    const { remote } = bridgeCall('import', op);
    const staging = join(root, op);
    mkdirSync(staging);
    writeFileSync(join(staging, input), `{"operation":"${op}"}\n`);
    const archive = join(root, `${op}.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', staging, input]).status, 0);
    // A bundle cut off partway through its second file, after the first was already unpacked.
    writeFileSync(join(staging, 'padding.bin'), randomBytes(200_000));
    const cut = join(root, `${op}-cut.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', cut, '-C', staging, input, 'padding.bin']).status, 0);
    truncateSync(cut, 100_000);

    const imported = runRemote(remote, { stdin: archive });
    assert.equal(imported.status, 0, `${op}: ${imported.stderr}`);
    assert.equal(imported.imported, `{"operation":"${op}"}\n`, op);
    assert.equal(imported.log[0], 'unpack', op);
    const command = `${nice ? 'nice -n 10 ' : ''}node server/dist/scripts/${importer} `;
    assert.ok(imported.log[1].startsWith(`run ${command}`), `${op}: ${imported.log[1]}`);
    assert.ok(imported.log[1].endsWith(`/container${bundle.replace('/tmp', '')}/${input} stdin=0`), `${op}: ${imported.log[1]}`);
    assert.match(imported.log[2], /^cleanup rm -rf /, op);
    assert.equal(imported.log.length, 3, op);
    assert.deepEqual(imported.leftovers, [], op);

    // The exit trap cleans up after a failed import too, and keeps the importer's status.
    const failed = runRemote(remote, { stdin: archive, env: { FAKE_STATUS: '3' } });
    assert.equal(failed.status, 3, op);
    assert.match(failed.log.at(-1) ?? '', /^cleanup rm -rf /, op);
    assert.deepEqual(failed.leftovers, [], op);

    const unpacked = runRemote(remote, { stdin: cut });
    assert.notEqual(unpacked.status, 0, op);
    assert.deepEqual(unpacked.log.map(line => line.split(' ')[0]), ['unpack', 'cleanup'], op);
    assert.equal(unpacked.imported, undefined, op);
    assert.deepEqual(unpacked.leftovers, [], op);

    // Only the imports with a floor refuse a nearly full disk, and they refuse before touching the container.
    const full = runRemote(remote, { stdin: archive, env: { FAKE_AVAILABLE_KB: '1000' } });
    if (floor) {
      assert.notEqual(full.status, 0, op);
      assert.deepEqual(full.log, [], op);
      assert.match(full.stdout.toString(), /capacity: 1000KB free; floor 5242880KB/, op);
    } else {
      assert.equal(full.status, 0, `${op}: ${full.stderr}`);
    }
    // A value the remote shell inherits never stands in for one the operation leaves out.
    const inherited = runRemote(remote, { stdin: archive, env: { NICENESS: '19', MIN_FREE_KB: '999999999999', FAKE_AVAILABLE_KB: '1000' } });
    assert.equal(inherited.status, floor ? 1 : 0, `${op}: ${inherited.stderr}`);
    if (!floor) assert.ok(inherited.log[1].startsWith(`run ${command}`), `${op}: ${inherited.log[1]}`);
  }
});

test('each export streams its gzipped records and fails when the exporter does', () => {
  for (const { op, exporter } of exports) {
    const { remote } = bridgeCall('export', op);
    const exported = runRemote(remote, { env: { FAKE_EXPORT_JSON: `{"export":"${op}"}` } });
    assert.equal(exported.status, 0, `${op}: ${exported.stderr}`);
    const unzipped = spawnSync('gunzip', ['-c'], { input: exported.stdout });
    assert.equal(unzipped.stdout.toString(), `{"export":"${op}"}`, op);
    assert.equal(exported.log[0], `run node server/dist/scripts/${exporter} stdin=0`, op);

    const failed = runRemote(remote, { env: { FAKE_EXPORT_JSON: '{"partial":', FAKE_STATUS: '1' } });
    assert.notEqual(failed.status, 0, op);
  }
});
