import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { encryptFile } from '../../scripts/offline/bridge-crypto.mjs';
import { sha256, writeExecutable } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Answers like gh, --jq included, from JSON in FAKE_STATE: successful-deploys.json and compare-<head>.json for what
// production runs, runs-<workflow>.json for the workflows production's queue holds, backup-runs.json for the backup
// workflow's runs (a dispatch adds run 501) and run.json for that run's state. A file holding "fail" answers like a
// failed API call. A download unpacks blob.dpb, after failing as many times as download-failures says.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_STATE"
printf '%s\\n' "$*" >> "$state/gh.log"
filter=.
workflow=
directory=
previous=
for arg in "$@"; do
  if [ "$previous" = --jq ]; then filter="$arg"; fi
  if [ "$previous" = --workflow ]; then workflow="$arg"; fi
  if [ "$previous" = -D ]; then directory="$arg"; fi
  previous="$arg"
done
answer() {
  local file="$state/$1" body="$2"
  if [ -f "$file" ]; then body="$(cat "$file")"; fi
  if [ "$body" = fail ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
  printf '%s\\n' "$body" | jq -r "$filter"
}
case "$*" in
  "run list "*"--status success"*) answer successful-deploys.json '[]' ;;
  "api repos/"*"/compare/"*) answer "compare-\${2##*...}.json" fail ;;
  "run list "*"--json status "*) answer "runs-$workflow.json" '[]' ;;
  "run list "*"--workflow offsite-backup.yml"*) answer backup-runs.json '[]' ;;
  "workflow run offsite-backup.yml "*)
    jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '[{databaseId: 501, createdAt: $now}] + .' "$state/backup-runs.json" > "$state/backup-runs.next"
    mv "$state/backup-runs.next" "$state/backup-runs.json" ;;
  "run view "*) answer run.json '{"status":"completed","conclusion":"success"}' ;;
  "run download "*)
    printf '%s\\n' "$TMPDIR" >> "$state/download-tmpdirs"
    failures="$(cat "$state/download-failures" 2>/dev/null || echo 0)"
    if [ "$failures" -gt 0 ]; then echo $((failures - 1)) > "$state/download-failures"; echo 'stream error' >&2; exit 1; fi
    mkdir -p "$directory"
    cp "$state/blob.dpb" "$directory/db-backup.dpb" ;;
  "run cancel "*) ;;
  "api repos/"*"/artifacts "*) answer artifacts.json '{"artifacts":[{"id":9001,"name":"db-backup"}]}' ;;
  "api -X DELETE "*) ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
`;

const SHA = 'a'.repeat(40);
const KEY = 'correct horse battery staple';
const HOUR = 60 * 60;
// What the workflow's remote script streams: a tar, gzipped. Its content doesn't matter here, only its size.
const TAR = Buffer.from('manifest.json, Caddyfile and the copy, as a tar\n'.repeat(500));

interface Setup {
  /** Files in the gh fake's state, as JSON unless a string. */
  state?: Record<string, unknown>;
  /** The purpose the downloaded blob was encrypted for. */
  purpose?: string;
  /** Files already in the backup root (a name ending in / is a folder), with their age in hours and their text. */
  root?: Record<string, number | [number, string]>;
}

async function fixture({ state = {}, purpose = 'db-backup:501', root = {} }: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'offsite-backup-'));
  const bin = join(dir, 'bin');
  const fake = join(dir, 'fake');
  const backups = join(dir, 'backups');
  mkdirSync(bin);
  mkdirSync(fake);
  writeExecutable(join(bin, 'gh'), FAKE_GH);
  // The script's own waits would only slow the test down.
  writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(dir, 'key'), `${KEY}\n`);
  const files: Record<string, unknown> = {
    'backup-runs.json': [{ databaseId: 500, createdAt: '2026-01-01T00:00:00Z' }],
    // Production runs exactly the required commit, and nothing waits in its queue.
    'successful-deploys.json': [{ headSha: SHA }],
    ...state,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(fake, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  writeFileSync(join(fake, 'gh.log'), '');
  await encryptFile({ input: Readable.from([gzipSync(TAR)]), output: join(fake, 'blob.dpb'), passphrase: KEY, purpose });
  for (const [name, value] of Object.entries(root)) {
    const [hours, text] = typeof value === 'number' ? [value, name] : value;
    mkdirSync(join(backups, name.split('/').slice(0, -1).join('/')), { recursive: true });
    if (!name.endsWith('/')) writeFileSync(join(backups, name), text);
    const time = Date.now() / 1_000 - hours * HOUR;
    utimesSync(join(backups, name), time, time);
  }
  const run = (env: Record<string, string> = {}, args: string[] = [SHA, backups]) => {
    const result = spawnSync('bash', [repoPath('scripts', 'offline', 'offsite-backup.sh'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        // Not the fixture: git on some machines writes into $HOME just after it exits, and that write would race
        // the fixture's removal. The bridge key's default path still points into the fixture.
        HOME: process.env.HOME ?? tmpdir(),
        XDG_CONFIG_HOME: join(dir, 'config'),
        TMPDIR: dir,
        GH_BIN: join(bin, 'gh'),
        NODE_BIN: process.execPath,
        GITHUB_REPOSITORY: 'owner/repo',
        SENTENCE_BRIDGE_KEY_FILE: join(dir, 'key'),
        FAKE_STATE: fake,
        ...env,
      },
    });
    const calls = readFileSync(join(fake, 'gh.log'), 'utf8').split('\n').filter(line => line !== '');
    writeFileSync(join(fake, 'gh.log'), '');
    return { ...result, calls };
  };
  const listing = () => existsSync(backups) ? readdirSync(backups).sort() : [];
  const blob = () => readFileSync(join(fake, 'blob.dpb'));
  return { dir, fake, backups, run, listing, blob, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FORCE = { OFFSITE_BACKUP_INTERVAL_HOURS: '0' };
const dispatches = (calls: string[]) => calls.filter(call => call.startsWith('workflow run ')).length;
const COPY = /^dictprop-db-\d{8}T\d{6}Z-501\.(?:dpb|json)$/;

test('the cycle makes no backup before the first one by hand, nor while the newest copy or a failed attempt is recent', async () => {
  const empty = await fixture();
  try {
    const first = empty.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /no off-site backup is kept in \S+ yet, and the first is made by hand: OFFSITE_BACKUP_INTERVAL_HOURS=0 /);
    assert.deepEqual(first.calls, []);
  } finally {
    empty.cleanup();
  }

  const recent = await fixture({
    root: { 'dictprop-db-20200301T000000Z-400.dpb': 10, '.last-attempt': [3, '2026-11-16T00:00:00Z off-site backup run 450 ended as failure\n'] },
  });
  try {
    const fresh = recent.run();
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /the newest off-site backup, dictprop-db-20200301T000000Z-400\.dpb, is 10 hour\(s\) old; the next is due at 162 hours/);
    assert.deepEqual(fresh.calls, []);

    // Due by the copy's age, but an attempt failed three hours ago, which holds the next one back for a day.
    const due = recent.run({ OFFSITE_BACKUP_INTERVAL_HOURS: '9' });
    assert.equal(due.status, 0, due.stderr);
    assert.match(due.stdout, /an off-site backup attempt failed 3 hour\(s\) ago \(2026-11-16T00:00:00Z off-site backup run 450 ended as failure\); the next attempt waits until a day has passed/);
    assert.deepEqual(due.calls, []);
  } finally {
    recent.cleanup();
  }
});

test('a backup waits while production does not run the required commit, is busy, or cannot be read', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ 'successful-deploys.json': [{ headSha: 'b'.repeat(40) }], [`compare-${'b'.repeat(40)}.json`]: { status: 'behind' } },
      /production does not run a{40} yet, and the backup needs that release's server script; trying again next cycle/],
    [{ 'successful-deploys.json': 'fail' }, /could not tell whether production runs a{40}; trying again next cycle/],
    [{ 'runs-deploy.yml.json': [{ status: 'queued' }] }, /a deploy, import, repair, recovery or backup is queued or running/],
    [{ 'runs-sentence-backfill.yml.json': [{ status: 'in_progress' }] }, /a deploy, import, repair, recovery or backup is queued or running/],
    [{ 'runs-recover-production.yml.json': 'fail' }, /could not tell whether production is busy; trying again next cycle/],
  ];
  for (const [state, message] of cases) {
    const setup = await fixture({ state });
    try {
      const result = setup.run(FORCE);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, message);
      assert.equal(dispatches(result.calls), 0);
      assert.deepEqual(setup.listing(), [], 'no attempt was made, so none is recorded');
    } finally {
      setup.cleanup();
    }
  }
});

test('a backup is downloaded, verified and kept privately, and its artifact and log are deleted', async () => {
  const setup = await fixture({ root: { '.download-77/tmp/': 30, '.last-attempt': 30 } });
  try {
    const result = setup.run(FORCE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /off-site backup complete: \S+\/dictprop-db-\d{8}T\d{6}Z-501\.dpb, \d+ encrypted bytes, the newest of 3 kept/);
    assert.deepEqual(result.calls, [
      'run list --repo owner/repo --workflow deploy.yml --branch main --status success --limit 5 --json headSha --jq .[].headSha',
      ...['deploy.yml', 'sentence-backfill.yml', 'recover-production.yml', 'offsite-backup.yml'].map(workflow =>
        `run list --repo owner/repo --workflow ${workflow} --limit 10 --json status --jq [.[] | select(.status != "completed")] | length`),
      'run list --repo owner/repo --workflow offsite-backup.yml --event workflow_dispatch --limit 1 --json databaseId --jq if length == 0 then 0 else .[0].databaseId end',
      'workflow run offsite-backup.yml --repo owner/repo --ref main',
      result.calls[7],
      'run view 501 --repo owner/repo --json status,conclusion --jq [.status, .conclusion] | @tsv',
      `run download 501 --repo owner/repo -n db-backup -D ${setup.backups}/.download-501/artifact`,
      'api repos/owner/repo/actions/runs/501/artifacts --jq .artifacts[] | select(.name == "db-backup") | .id',
      'api -X DELETE repos/owner/repo/actions/artifacts/9001',
      'api -X DELETE repos/owner/repo/actions/runs/501/logs',
    ]);
    assert.match(result.calls[7], /^run list --repo owner\/repo --workflow offsite-backup\.yml --event workflow_dispatch --limit 10 --json databaseId,createdAt --jq \.\[\] \| select\(\.databaseId > 500 and \.createdAt >= "[^"]+"\) \| \.databaseId$/);
    // gh's temporary copy of the artifact stayed inside the private download, which is gone with the stale one.
    assert.equal(readFileSync(join(setup.fake, 'download-tmpdirs'), 'utf8'), `${setup.backups}/.download-501/tmp\n`);

    const listing = setup.listing();
    assert.equal(listing.length, 2);
    for (const name of listing) {
      assert.match(name, COPY);
      assert.equal(statSync(join(setup.backups, name)).mode & 0o777, 0o600, name);
    }
    assert.equal(statSync(setup.backups).mode & 0o777, 0o700);
    const copy = listing.find(name => name.endsWith('.dpb')) ?? '';
    const sidecar = listing.find(name => name.endsWith('.json')) ?? '';
    assert.deepEqual(readFileSync(join(setup.backups, copy)), setup.blob(), 'the copy stays encrypted, byte for byte');
    const description = JSON.parse(readFileSync(join(setup.backups, sidecar), 'utf8'));
    assert.deepEqual({ ...description, createdAt: typeof description.createdAt }, {
      version: 1,
      runId: 501,
      purpose: 'db-backup:501',
      createdAt: 'string',
      encryptedBytes: setup.blob().length,
      sha256: sha256(setup.blob()),
      plaintextBytes: TAR.length,
    });
    assert.ok(Math.abs(Date.parse(description.createdAt) - Date.now()) < 60_000);
  } finally {
    setup.cleanup();
  }
});

test('only the newest copies are kept, each with its sidecar', async () => {
  const setup = await fixture({
    root: {
      'dictprop-db-20200101T000000Z-100.dpb': 1000, 'dictprop-db-20200101T000000Z-100.json': 1000,
      'dictprop-db-20200108T000000Z-200.dpb': 800, 'dictprop-db-20200108T000000Z-200.json': 800,
      'dictprop-db-20200115T000000Z-300.dpb': 600, 'dictprop-db-20200115T000000Z-300.json': 600,
      // A sidecar whose copy is already gone.
      'dictprop-db-20191201T000000Z-50.json': 2000,
    },
  });
  try {
    const result = setup.run({ OFFSITE_BACKUP_INTERVAL_HOURS: '162' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed the older off-site backup dictprop-db-20200101T000000Z-100\.dpb/);
    const listing = setup.listing();
    assert.deepEqual(listing.slice(0, 4), [
      'dictprop-db-20200108T000000Z-200.dpb', 'dictprop-db-20200108T000000Z-200.json',
      'dictprop-db-20200115T000000Z-300.dpb', 'dictprop-db-20200115T000000Z-300.json',
    ]);
    assert.equal(listing.length, 6);
    for (const name of listing.slice(4)) assert.match(name, COPY);
  } finally {
    setup.cleanup();
  }
});

test('a blob made for another run is refused, nothing is kept, and the attempt holds the next one back for a day', async () => {
  const setup = await fixture({ purpose: 'db-backup:999', root: { 'dictprop-db-20200115T000000Z-300.dpb': 600 } });
  try {
    const result = setup.run({ OFFSITE_BACKUP_INTERVAL_HOURS: '162' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bridge-crypto: verify failed: bridge blob failed authentication/);
    assert.match(result.stderr, /the artifact of run 501 did not verify for db-backup:501/);
    assert.deepEqual(setup.listing(), ['.last-attempt', 'dictprop-db-20200115T000000Z-300.dpb']);
    assert.match(readFileSync(join(setup.backups, '.last-attempt'), 'utf8'),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z the artifact of run 501 did not verify for db-backup:501\n$/);
    // The artifact stays for inspection; GitHub expires it within a day.
    assert.equal(result.calls.filter(call => call.startsWith('api -X DELETE ')).length, 0);

    const next = setup.run({ OFFSITE_BACKUP_INTERVAL_HOURS: '162' });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /an off-site backup attempt failed 0 hour\(s\) ago/);
    assert.deepEqual(next.calls, []);
  } finally {
    setup.cleanup();
  }
});

test('a run that fails or outlasts its wait, or an artifact that will not download, is a failed attempt', async () => {
  const cases: Array<[Setup, Record<string, string>, RegExp]> = [
    [{ state: { 'run.json': { status: 'completed', conclusion: 'failure' } } }, {}, /off-site backup run 501 ended as failure/],
    [{ state: { 'run.json': { status: 'in_progress', conclusion: null } } }, { OFFSITE_BACKUP_WAIT_SECONDS: '1' },
      /off-site backup run 501 did not finish within 1s; cancelled it/],
    [{ state: { 'download-failures': '3' } }, {}, /could not download the artifact of run 501 within 3600s/],
  ];
  for (const [setupOptions, env, message] of cases) {
    const setup = await fixture(setupOptions);
    try {
      const result = setup.run({ ...FORCE, ...env });
      assert.equal(result.status, 1, `${message}: ${result.stdout}`);
      assert.match(result.stderr, message);
      assert.deepEqual(setup.listing(), ['.last-attempt']);
      if (env.OFFSITE_BACKUP_WAIT_SECONDS) assert.ok(result.calls.includes('run cancel 501 --repo owner/repo'));
    } finally {
      setup.cleanup();
    }
  }

  // A download that fails once is tried again.
  const flaky = await fixture({ state: { 'download-failures': '1' } });
  try {
    const result = flaky.run(FORCE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /the download of run 501's artifact failed \(attempt 1\/3\)/);
    assert.equal(flaky.listing().length, 2);
  } finally {
    flaky.cleanup();
  }
});

test('arguments and settings are checked before anything else', async () => {
  const setup = await fixture();
  try {
    for (const [env, args, message] of [
      [{}, [], /Usage: offsite-backup\.sh <required-deploy-sha>/],
      [{}, ['abc1234'], /required-deploy-sha must be a commit this checkout knows or a full 40-character SHA: abc1234/],
      [{ OFFSITE_BACKUP_INTERVAL_HOURS: 'weekly' }, [SHA], /OFFSITE_BACKUP_INTERVAL_HOURS must be a whole number of hours/],
      [{ OFFSITE_BACKUP_KEEP: '0' }, [SHA], /OFFSITE_BACKUP_KEEP must be a positive integer/],
    ] as const) {
      const result = setup.run(env, [...args]);
      assert.equal(result.status, 2, String(message));
      assert.match(result.stderr, message);
      assert.deepEqual(result.calls, []);
    }
  } finally {
    setup.cleanup();
  }
});
