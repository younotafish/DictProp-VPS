import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(join(repoRoot, '.github/workflows/sentence-backfill.yml'), 'utf8');

// Each import job, the release asset it decrypts, and the server script that imports the bundle.
const imports = [
  { op: 'import', asset: 'sentence-backfill.enc', importer: 'import-sentence-backfill.js', dispatcher: 'dispatch-staged-saved-sentence-analyses.sh' },
  { op: 'enrichment-import', asset: 'sentence-enrichments.enc', importer: 'import-sentence-enrichments.js', dispatcher: 'dispatch-staged-example-analyses.sh' },
  { op: 'enrichment-import', asset: 'sentence-enrichments.enc', importer: 'import-sentence-enrichments.js', dispatcher: 'dispatch-staged-example-enrichments.sh' },
  { op: 'essay-import', asset: 'private-essay-catalog.enc', importer: 'import-private-essay-catalog.js', dispatcher: 'publish-private-essay-catalog.sh' },
  { op: 'corpus-import', asset: 'corpus-audit.enc', importer: 'import-corpus-audit.js', dispatcher: 'dispatch-staged-corpus-audit.sh' },
  { op: 'image-import', asset: 'offline-images.enc', importer: 'import-offline-images.js', dispatcher: 'dispatch-staged-offline-images.sh' },
  { op: 'audio-import', asset: 'offline-audio.enc', importer: 'import-offline-tts.js', dispatcher: 'dispatch-staged-offline-audio.sh' },
];
const exports = [
  { op: 'export', artifact: 'sentence-export', exporter: 'export-sentence-backfill.js' },
  { op: 'corpus-export', artifact: 'corpus-export', exporter: 'export-corpus-audit.js' },
];

/** The workflow's jobs by id: each runs from its two-space-indented key to the next one. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const result = new Map<string, string>();
  const keys = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  keys.forEach((match, index) => {
    result.set(match[1], body.slice(match.index, keys[index + 1]?.index ?? body.length));
  });
  return result;
}

/** A `key: |` block scalar, dedented. */
function block(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex(line => new RegExp(`^\\s*(?:- )?${key}: \\|\\s*$`).test(line));
  assert.notEqual(start, -1, `${key} block`);
  const keyIndent = lines[start].search(/\S/);
  const content: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= keyIndent) break;
    content.push(line);
  }
  const indent = Math.min(...content.filter(line => line.trim()).map(line => line.search(/\S/)));
  return content.map(line => line.slice(indent)).join('\n').trimEnd() + '\n';
}

/** Every `run:` value in the text, inline or block. */
function runs(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/^([ \t]*)(?:- )?run: (.*)$/gm)) {
    values.push(match[2].trim() === '|' ? block(text.slice(match.index), 'run') : match[2]);
  }
  return values;
}

const jobsById = jobs(workflow);
const job = (id: string) => {
  const text = jobsById.get(id);
  assert.ok(text, `job ${id}`);
  return text;
};

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

test('exports leave the runner only as an encrypted artifact that expires within a day', () => {
  for (const { op, artifact, exporter } of exports) {
    const text = job(op);
    assert.match(text, new RegExp(`if: inputs\\.operation == '${op}'`));
    assert.deepEqual(runs(text), [`bash scripts/offline/bridge-export.sh ${artifact} "$RUNNER_TEMP/${artifact}.dpb"`]);
    assert.match(block(text, 'REMOTE_SCRIPT'), new RegExp(`node server/dist/scripts/${exporter} \\| gzip -9\\n$`));
    const upload = text.slice(text.indexOf('uses: actions/upload-artifact@'));
    assert.match(upload, new RegExp(`name: ${artifact}\\n`));
    assert.match(upload, new RegExp(`path: \\$\\{\\{ runner\\.temp \\}\\}/${artifact}\\.dpb\\n`));
    assert.match(upload, /if-no-files-found: error\n/);
  }
  const uploads = [...workflow.matchAll(/uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n((?: {8,}.*\n)+)/g)];
  assert.equal(uploads.length, exports.length);
  for (const [, settings] of uploads) assert.match(settings, /^\s+retention-days: 1$/m);
});

test('each import decrypts only its own asset and streams it to its importer', () => {
  for (const { op, asset, importer } of imports) {
    const text = job(op);
    assert.match(text, new RegExp(`if: inputs\\.operation == '${op}'`));
    assert.match(text, /group: dictprop-production\n/);
    assert.match(text, /\[\[ "\$RELEASE_TAG" =~ \^\[A-Za-z0-9\._-\]\{1,200\}\$ \]\]/);
    assert.deepEqual(runs(text).slice(-1), [`bash scripts/offline/bridge-import.sh ${op} ${asset}`]);
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(text, /RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/);
    const remote = block(text, 'REMOTE_SCRIPT');
    // Only the unpacking reads the bundle; everything else runs with standard input closed.
    const closed = remote.indexOf('exec 3<&0 < /dev/null');
    assert.ok(closed >= 0 && closed < remote.indexOf('docker compose'), op);
    assert.equal(remote.match(/<&3/g)?.length, 1, op);
    assert.match(remote, new RegExp(`node server/dist/scripts/${importer.replace('.', '\\.')}`));
  }
});

test('each dispatcher binds its archive to the import job that decrypts it', () => {
  for (const { op, asset, dispatcher } of imports) {
    const script = readFileSync(join(repoRoot, 'scripts/offline', dispatcher), 'utf8');
    assert.match(script, new RegExp(`ARCHIVE="\\$[A-Z_]+/${asset.replace('.', '\\.')}"`), dispatcher);
    assert.ok(script.includes(`--purpose "import:${op}:$RELEASE_TAG"`), dispatcher);
    assert.match(script, new RegExp(`\\b${asset.replace('.', '\\.')}\\s*\\\\?\\s*${op}\\b`), dispatcher);
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
  for (const [id, text] of jobsById) {
    if (!text.includes('scripts/offline/bridge-')) continue;
    const checkout = block(text, 'sparse-checkout').trim().split('\n').sort();
    const script = id.endsWith('export') ? 'bridge-export.sh' : 'bridge-import.sh';
    assert.deepEqual(checkout, [`scripts/offline/bridge-crypto.mjs`, `scripts/offline/${script}`, 'scripts/offline/vps-ssh.sh'], id);
    assert.match(text, /VPS_SSH_KEY: \$\{\{ secrets\.VPS_SSH_KEY \}\}/, id);
  }
});

// Runs a job's REMOTE_SCRIPT as the VPS would, with docker and df stood in for, and production paths
// moved under a temporary root.
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
  const result = spawnSync('/bin/bash', ['-c', script], {
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
    container: join(root, 'container'),
  };
  rmSync(root, { recursive: true, force: true });
  return output;
}

test('each import unpacks the streamed bundle, imports it with standard input closed, and cleans up', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { op, importer } of imports.filter((entry, index, all) => all.findIndex(other => other.op === entry.op) === index)) {
    const remote = block(job(op), 'REMOTE_SCRIPT');
    const target = remote.match(/\/tmp\/[a-z-]+\/([a-z]+\.json)\n/)?.[1];
    assert.ok(target, op);
    const staging = join(root, op);
    mkdirSync(staging);
    writeFileSync(join(staging, target), `{"operation":"${op}"}\n`);
    const bundle = join(root, `${op}.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', bundle, '-C', staging, target]).status, 0);

    const imported = runRemote(remote, { stdin: bundle });
    assert.equal(imported.status, 0, `${op}: ${imported.stderr}`);
    assert.equal(imported.imported, `{"operation":"${op}"}\n`, op);
    assert.equal(imported.log[0], 'unpack', op);
    assert.match(imported.log[1], new RegExp(`^run .*node server/dist/scripts/${importer.replace('.', '\\.')} .*/${target} stdin=0$`), op);
    assert.match(imported.log[2], /^cleanup rm -rf /, op);
    assert.equal(imported.log.length, 3, op);

    const failed = runRemote(remote, { stdin: bundle, env: { FAKE_STATUS: '3' } });
    assert.equal(failed.status, 3, op);
    assert.match(failed.log.at(-1) ?? '', /^cleanup rm -rf /, op);

    if (remote.includes('MIN_FREE_KB')) {
      const full = runRemote(remote, { stdin: bundle, env: { FAKE_AVAILABLE_KB: '1000' } });
      assert.notEqual(full.status, 0, op);
      assert.deepEqual(full.log, [], op);
    }
  }
});

test('each export streams its gzipped records and fails when the exporter does', () => {
  for (const { op } of exports) {
    const remote = block(job(op), 'REMOTE_SCRIPT');
    const exported = runRemote(remote, { env: { FAKE_EXPORT_JSON: `{"export":"${op}"}` } });
    assert.equal(exported.status, 0, `${op}: ${exported.stderr}`);
    const unzipped = spawnSync('gunzip', ['-c'], { input: exported.stdout });
    assert.equal(unzipped.stdout.toString(), `{"export":"${op}"}`, op);
    assert.match(exported.log[0], /stdin=0$/, op);

    const failed = runRemote(remote, { env: { FAKE_EXPORT_JSON: '{"partial":', FAKE_STATUS: '1' } });
    assert.notEqual(failed.status, 0, op);
  }
});
