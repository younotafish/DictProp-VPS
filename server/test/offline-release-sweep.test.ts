import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PUBLISHER_TAG_PATTERN,
  removeDecryptionTempFiles,
  removeLeftovers,
  selectDecryptionTempFiles,
  selectLocalLeftovers,
  selectStaleReleases,
} from '../../scripts/offline/bridge-leftovers.mjs';

const sweep = fileURLToPath(new URL('../../scripts/offline/sweep-bridge-leftovers.sh', import.meta.url));
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-01T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, content: string | Buffer = 'x') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Sets every entry under path, path included, to the same modification time.
function age(path: string, ms: number) {
  const seconds = ms / 1_000;
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) age(join(path, name), ms);
  }
  utimesSync(path, seconds, seconds);
}

function wave(root: string, name: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) write(join(root, name, path), content);
  return join(root, name);
}

test('only the exact tags the publishers create are candidates', () => {
  for (const tag of [
    'corpus-audit-wave-0001-20261001T120000Z',
    'example-analyses-wave-0042-20261001T120000Z',
    'sentence-grammar-wave-0003-20261001T120000Z',
    'example-enrichments-wave-12345-20261001T120000Z',
    'vocab-images-wave-0001-20261001T120000Z',
    'real-life-audio-wave-0001-20261001T120000Z',
    'private-essays-20261001T120000Z',
  ]) {
    assert.match(tag, PUBLISHER_TAG_PATTERN);
  }
  for (const tag of [
    'v1.0.0',
    'corpus-audit-wave-001-20261001T120000Z',
    'corpus-audit-wave-0001-20261001T120000Z-copy',
    'corpus-audit-wave-0001-20261001T120000',
    'corpus-audit-20261001T120000Z',
    'Corpus-audit-wave-0001-20261001T120000Z',
    ' corpus-audit-wave-0001-20261001T120000Z',
    'sentence-backfill-wave-0001-20261001T120000Z',
    'private-essays-wave-0001-20261001T120000Z',
    'private-essays-2026-10-01',
    'example-enrichments-wave-0001-20261001T120000Z\n',
  ]) {
    assert.doesNotMatch(tag, PUBLISHER_TAG_PATTERN, JSON.stringify(tag));
  }
});

test('a release is stale only when its newest timestamp, assets included, is more than six hours old', () => {
  const old = at(now - 3 * DAY);
  const pages = [
    [
      // GitHub dates a release by its tag's commit; the publication time is what counts.
      { tag_name: 'corpus-audit-wave-0001-20260928T120000Z', created_at: old, published_at: at(now - 2 * HOUR), assets: [] },
      // An asset uploaded an hour ago keeps an old release alive.
      {
        tag_name: 'vocab-images-wave-0001-20260928T120000Z',
        created_at: old,
        published_at: old,
        assets: [{ created_at: old, updated_at: at(now - HOUR) }],
      },
      { tag_name: 'example-analyses-wave-0002-20260928T120000Z', created_at: old, published_at: at(now - 7 * HOUR), assets: [] },
      { tag_name: 'v1.0.0', created_at: old, published_at: old, assets: [] },
    ],
    [
      { tag_name: 'private-essays-20260928T120000Z', created_at: old, published_at: null, assets: [{ created_at: old, updated_at: old }] },
      { tag_name: 'sentence-grammar-wave-0001-20260928T120000Z', created_at: null, published_at: null, assets: [] },
      { tag_name: 'real-life-audio-wave-0001-20260928T120000Z', created_at: at(now - 6 * HOUR), assets: [] },
    ],
  ];
  const stale = selectStaleReleases(pages, { now });
  assert.deepEqual(stale.map(({ tag }: { tag: string }) => tag), [
    'example-analyses-wave-0002-20260928T120000Z',
    'private-essays-20260928T120000Z',
  ]);
  assert.equal(stale[0].idleMs, 7 * HOUR);

  // A single unslurped page works too, and anything but an array is an error.
  assert.deepEqual(selectStaleReleases(pages[1], { now }).map(({ tag }: { tag: string }) => tag), ['private-essays-20260928T120000Z']);
  assert.deepEqual(selectStaleReleases([[]], { now }), []);
  assert.throws(() => selectStaleReleases({ message: 'Not Found' }, { now }), /expected a JSON array/);
});

test('failed waves go after a week idle, and only archives leave published waves', t => {
  const root = tempDir(t);
  const fingerprints = join(root, 'fingerprinted');

  const oldFailed = wave(root, 'wave-0001.failed', { 'manifest.json': '{}', 'corpus-audit.enc': 'blob', 'publisher/failed': 'x' });
  age(oldFailed, now - 8 * DAY);
  const recentlyTouched = wave(root, 'wave-0002.failed', { 'manifest.json': '{}', 'publisher/failed': 'x' });
  age(recentlyTouched, now - 8 * DAY);
  utimesSync(join(recentlyTouched, 'publisher/failed'), (now - DAY) / 1_000, (now - DAY) / 1_000);
  const stamped = wave(root, 'wave-0002.failed-20260920T000000Z', { 'manifest.json': '{}' });
  age(stamped, now - 10 * DAY);

  const published = wave(root, 'wave-0003', {
    'manifest.json': '{}', 'release-tag': 'tag\n', published: '2026-09-01T00:00:00Z\n',
    'sentence-enrichments.enc': 'blob', 'images/a.webp': 'image', 'publisher/complete': 'done\n',
  });
  // Published remotely before the dispatcher could copy the marker.
  const completed = wave(root, 'wave-0004', { 'manifest.json': '{}', 'publisher/complete': 'done\n', 'sentence-enrichments.enc': 'blob' });
  const unpublished = wave(root, 'wave-0005', { 'manifest.json': '{}', published: '', 'sentence-enrichments.enc': 'blob' });
  const inFingerprint = wave(fingerprints, 'abc123/wave-0001', { published: 'x', 'offline-images.enc': 'blob' });
  const failedInFingerprint = wave(fingerprints, 'abc123/wave-0002.failed', { 'manifest.json': '{}' });
  age(failedInFingerprint, now - 30 * DAY);
  // Waves are never looked for deeper than one directory below a root.
  const tooDeep = wave(fingerprints, 'abc123/nested/wave-0001', { published: 'x', 'deep.enc': 'blob' });
  // A name that only resembles a wave is left alone.
  const lookalike = wave(root, 'wave-0006.failedx', { 'manifest.json': '{}' });
  age(lookalike, now - 30 * DAY);

  const leftovers = selectLocalLeftovers([root, fingerprints, fingerprints, join(root, 'missing')], { now });
  assert.deepEqual(leftovers.map(({ kind, path }: { kind: string; path: string }) => [kind, path]).sort(), [
    ['failed wave', failedInFingerprint],
    ['failed wave', oldFailed],
    ['failed wave', stamped],
    ['published archive', join(completed, 'sentence-enrichments.enc')],
    ['published archive', join(inFingerprint, 'offline-images.enc')],
    ['published archive', join(published, 'sentence-enrichments.enc')],
  ].sort());

  const lines: string[] = [];
  removeLeftovers(leftovers, { dryRun: true, log: (line: string) => lines.push(line) });
  assert.equal(lines.filter(line => line.startsWith('would remove failed wave ')).length, 3);
  assert.match(lines.at(-1) ?? '', /^would remove 3 failed wave\(s\) and 3 published archive\(s\) \(0\.0 MB\)$/);
  for (const { path } of leftovers) assert.ok(existsSync(path), `dry run kept ${path}`);

  removeLeftovers(leftovers, { log: (line: string) => lines.push(line) });
  for (const path of [oldFailed, stamped, failedInFingerprint, join(published, 'sentence-enrichments.enc'),
    join(completed, 'sentence-enrichments.enc'), join(inFingerprint, 'offline-images.enc')]) {
    assert.equal(existsSync(path), false, path);
  }
  for (const path of ['manifest.json', 'release-tag', 'published', 'images/a.webp', 'publisher/complete']) {
    assert.ok(existsSync(join(published, path)), path);
  }
  for (const path of [recentlyTouched, join(unpublished, 'sentence-enrichments.enc'), join(tooDeep, 'deep.enc'), lookalike]) {
    assert.ok(existsSync(path), path);
  }
  assert.deepEqual(selectLocalLeftovers([root, fingerprints], { now }), []);
});

test('symlinks are never followed or removed', t => {
  const root = tempDir(t);
  const outside = tempDir(t);
  const target = wave(outside, 'wave-0009.failed', { 'manifest.json': '{}' });
  age(target, now - 30 * DAY);
  write(join(outside, 'keep.enc'), 'blob');
  symlinkSync(target, join(root, 'wave-0001.failed'));
  symlinkSync(outside, join(root, 'linked-fingerprint'));
  const published = wave(root, 'wave-0002', { published: 'x' });
  symlinkSync(join(outside, 'keep.enc'), join(published, 'linked.enc'));

  assert.deepEqual(selectLocalLeftovers([root], { now }), []);
  assert.ok(existsSync(join(target, 'manifest.json')));
  assert.ok(existsSync(join(outside, 'keep.enc')));
});

test('decryption temp files idle for a day go from anywhere under a root, and nothing else does', t => {
  const root = tempDir(t);
  const outside = tempDir(t);
  const old = join(root, 'incremental-example-enrichment', '.current-corpus.json.decrypting-123-abcdef012345');
  const nested = join(root, 'incremental-example-enrichment', 'saved-sentences', '.export.json.gunzipping-77-0123456789ab');
  const fresh = join(root, '.current-corpus.json.decrypting-456-abcdef012345');
  // Encryption's temp files hold no plaintext, and names that only resemble decryption's are someone else's.
  const kept = [
    fresh,
    join(root, '.wave.enc.encrypting-123-abcdef012345'),
    join(root, 'current-corpus.json.decrypting-123-abcdef012345'),
    join(root, '.current-corpus.json.decrypting-123-abcdef'),
    join(root, '.current-corpus.json.decrypting-123-abcdef012345.bak'),
  ];
  for (const path of [old, nested, ...kept]) write(path, 'plaintext');
  for (const path of [old, ...kept.slice(1)]) age(path, now - 2 * DAY);
  age(nested, now - 25 * HOUR);
  age(fresh, now - HOUR);
  // A symlink named like a temp file stays, and so does a temp file that only a linked directory reaches.
  const linkedTemp = join(outside, '.secret.json.decrypting-9-0123456789ab');
  write(linkedTemp, 'plaintext');
  age(linkedTemp, now - 3 * DAY);
  symlinkSync(linkedTemp, join(root, '.linked.json.decrypting-9-0123456789ab'));
  symlinkSync(outside, join(root, 'linked-data'));

  const files = selectDecryptionTempFiles([root, join(root, 'incremental-example-enrichment'), join(root, 'missing')], { now });
  assert.deepEqual(files.map(({ path }: { path: string }) => path).sort(), [nested, old].sort());
  assert.deepEqual(files.find(({ path }: { path: string }) => path === old), { path: old, idleMs: 2 * DAY, bytes: 9 });

  const lines: string[] = [];
  removeDecryptionTempFiles(files, { dryRun: true, log: (line: string) => lines.push(line) });
  assert.ok(lines.includes(`would remove decryption temp file ${old} (0.0 MB, idle 2.0 days)`), lines.join('\n'));
  assert.equal(lines.at(-1), 'would remove 2 decryption temp file(s) (0.0 MB)');
  for (const path of [old, nested]) assert.ok(existsSync(path), `dry run kept ${path}`);

  removeDecryptionTempFiles(files, { log: (line: string) => lines.push(line) });
  assert.equal(lines.at(-1), 'removed 2 decryption temp file(s) (0.0 MB)');
  for (const path of [old, nested]) assert.equal(existsSync(path), false, path);
  for (const path of [...kept, linkedTemp, join(root, '.linked.json.decrypting-9-0123456789ab')]) {
    assert.ok(existsSync(path), path);
  }
  assert.deepEqual(selectDecryptionTempFiles([root], { now }), []);
  // A day is the default limit, and another can be given.
  assert.deepEqual(selectDecryptionTempFiles([root], { now, maxAgeMs: HOUR / 2 }).map(({ path }: { path: string }) => path), [fresh]);
});

// A stand-in for the GitHub CLI: logs each call, serves the release list, and fails to delete one tag.
function fakeGh(dir: string, releases: unknown, { failList = false, failDelete = '' } = {}) {
  const calls = join(dir, 'gh-calls.log');
  const releasesFile = join(dir, 'releases.json');
  writeFileSync(releasesFile, JSON.stringify(releases));
  const gh = join(dir, 'gh');
  writeFileSync(gh, [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
    'case "$1" in',
    `  api) ${failList ? 'echo "HTTP 502" >&2; exit 1' : `cat ${JSON.stringify(releasesFile)}`} ;;`,
    `  release) [ "$3" != ${JSON.stringify(failDelete)} ] ;;`,
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(gh, 0o755);
  return { gh, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

// dataRoot stands in for data/offline-backfill, where the sweep looks for decryption temp files.
function runSweep(gh: string, args: string[], dataRoot: string) {
  return spawnSync('/bin/bash', [sweep, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, GH_BIN: gh, GITHUB_REPOSITORY: 'owner/repo', GH_CALL_TIMEOUT_SECONDS: '30', OFFLINE_DATA_ROOT: dataRoot,
    },
    timeout: 60_000,
  });
}

test('the sweep deletes stale publisher releases, clears the wave roots and old decryption temp files, and --dry-run deletes nothing', t => {
  const dir = tempDir(t);
  const root = join(dir, 'state');
  const data = join(dir, 'data');
  const failed = wave(root, 'wave-0001.failed', { 'manifest.json': '{}' });
  age(failed, Date.now() - 8 * DAY);
  const published = wave(root, 'wave-0002', { published: 'x', 'corpus-audit.enc': 'blob' });
  const killedTemp = join(data, 'incremental-example-enrichment', '.current-corpus.json.decrypting-123-abcdef012345');
  write(killedTemp, 'plaintext');
  age(killedTemp, Date.now() - 2 * DAY);
  const runningTemp = join(data, '.export.json.gunzipping-77-0123456789ab');
  write(runningTemp, 'plaintext');
  const old = at(Date.now() - 3 * DAY);
  const releases = [[
    { tag_name: 'corpus-audit-wave-0001-20260928T120000Z', created_at: old, published_at: old, assets: [] },
    { tag_name: 'vocab-images-wave-0002-20260928T120000Z', created_at: old, published_at: old, assets: [] },
    { tag_name: 'example-analyses-wave-0003-20261001T110000Z', created_at: old, published_at: at(Date.now() - HOUR), assets: [] },
    { tag_name: 'v1.0.0', created_at: old, published_at: old, assets: [] },
  ]];

  const dry = fakeGh(dir, releases);
  const preview = runSweep(dry.gh, ['--dry-run', root], data);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(dry.calls(), ['api --paginate --slurp repos/owner/repo/releases?per_page=100']);
  assert.match(preview.stdout, /would delete release corpus-audit-wave-0001-20260928T120000Z \(idle 72\.0 h\)/);
  assert.match(preview.stdout, /would delete release vocab-images-wave-0002-20260928T120000Z/);
  assert.doesNotMatch(preview.stdout, /example-analyses|v1\.0\.0/);
  assert.match(preview.stdout, /would remove failed wave .*wave-0001\.failed/);
  assert.match(preview.stdout, /would remove published archive .*wave-0002\/corpus-audit\.enc/);
  assert.match(preview.stdout, /would remove decryption temp file .*\/\.current-corpus\.json\.decrypting-123-abcdef012345 \(0\.0 MB, idle 2\.0 days\)/);
  assert.match(preview.stdout, /would remove 1 decryption temp file\(s\) \(0\.0 MB\)/);
  assert.ok(existsSync(failed) && existsSync(join(published, 'corpus-audit.enc')) && existsSync(killedTemp));
  rmSync(join(dir, 'gh-calls.log'));

  // One delete fails: the rest still runs, and the sweep reports the failure.
  const real = fakeGh(dir, releases, { failDelete: 'vocab-images-wave-0002-20260928T120000Z' });
  const swept = runSweep(real.gh, [root], data);
  assert.equal(swept.status, 1);
  assert.deepEqual(real.calls(), [
    'api --paginate --slurp repos/owner/repo/releases?per_page=100',
    'release delete corpus-audit-wave-0001-20260928T120000Z --repo owner/repo --yes --cleanup-tag',
    'release delete vocab-images-wave-0002-20260928T120000Z --repo owner/repo --yes --cleanup-tag',
  ]);
  assert.match(swept.stdout, /deleted release corpus-audit-wave-0001-20260928T120000Z/);
  assert.match(swept.stdout, /could not delete release vocab-images-wave-0002-20260928T120000Z/);
  assert.equal(existsSync(failed), false);
  assert.equal(existsSync(join(published, 'corpus-audit.enc')), false);
  assert.ok(existsSync(join(published, 'published')));
  assert.match(swept.stdout, /removed decryption temp file .*\.current-corpus\.json\.decrypting-123-abcdef012345/);
  assert.equal(existsSync(killedTemp), false);
  assert.ok(existsSync(runningTemp));
});

test('a release list that cannot be read still lets the wave roots be cleared, and fails the sweep', t => {
  const dir = tempDir(t);
  const root = join(dir, 'state');
  const published = wave(root, 'wave-0001', { published: 'x', 'offline-images.enc': 'blob' });
  const { gh, calls } = fakeGh(dir, [], { failList: true });
  const result = runSweep(gh, [root], join(dir, 'data'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not list the repository's releases/);
  assert.equal(calls().filter(call => call.startsWith('release')).length, 0);
  assert.equal(existsSync(join(published, 'offline-images.enc')), false);

  const usage = runSweep(gh, ['--dry-run'], join(dir, 'data'));
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: .*sweep-bridge-leftovers\.sh \[--dry-run\] <wave-state-root>/);
});
