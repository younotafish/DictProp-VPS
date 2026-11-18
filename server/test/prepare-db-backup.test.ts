import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { png } from './support/fs.js';
import { addItemImage, createOwner, saveItem, storeExample } from './support/library.js';
import { spawnScript } from './support/scripts.js';

const { db } = await import('../src/db.js');

const backups = join(process.env.DATA_DIR!, 'backups');
const owner = createOwner();
saveItem(owner.id, 'serene', 'vocab', { word: 'serene' });
saveItem(owner.id, 'placid', 'vocab', { word: 'placid' });
addItemImage(owner.id, 'serene');
storeExample('A serene lake at dawn.', { translation: 'A calm lake.' }, png('lake'));
const COUNTS = {
  users: 1, items: 2, review_events: 0, item_images: 1, image_blobs: 2, sentence_enrichments: 1, comparisons: 0, item_themes: 0,
};

// Stands in for the database or a migration logging while the script runs: at exit, after everything the script
// imports has loaded, this writes through console.log, which must not reach the manifest on standard output.
const noisy = join(tmpdir(), 'log-at-exit.mjs');
writeFileSync(noisy, "process.on('exit', () => console.log('a module logged this'));\n");

/** Runs the script as the workflow does, and returns its manifest, the one line it prints. */
function prepare() {
  const run = spawnScript('prepare-db-backup', [], { NODE_OPTIONS: `--import ${pathToFileURL(noisy).href}` });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^[^\n]+\n$/, 'exactly one line on standard output');
  assert.match(run.stderr, /a module logged this/);
  return JSON.parse(run.stdout) as {
    version: number; copy: string; bytes: number; pageSize: number; pageCount: number;
    counts: Record<string, number>; createdAt: string;
  };
}

const copies = () => readdirSync(backups).filter(name => name.endsWith('.db')).sort();
const seconds = (ms: number) => Math.floor(ms / 1_000) * 1_000;

test('the manifest is the only line on standard output and describes the fresh copy the script made', () => {
  rmSync(backups, { recursive: true, force: true });
  const started = seconds(Date.now());
  const manifest = prepare();
  const finished = Date.now();

  assert.equal(manifest.version, 1);
  assert.match(manifest.copy, /^pre-offsite-\d{8}T\d{6}Z\.db$/);
  assert.deepEqual(copies(), [manifest.copy]);
  assert.equal(manifest.bytes, statSync(join(backups, manifest.copy)).size);
  // The copy holds every page in its main file, so a restore needs nothing beside it.
  assert.equal(manifest.pageSize * manifest.pageCount, manifest.bytes);
  assert.deepEqual(manifest.counts, COUNTS);
  const createdAt = Date.parse(manifest.createdAt);
  assert.ok(createdAt >= started && createdAt <= finished, manifest.createdAt);

  // Within twelve hours the slot's copy is reused, as imports and deploys reuse it.
  saveItem(owner.id, 'tranquil', 'vocab', { word: 'tranquil' });
  const again = prepare();
  assert.equal(again.copy, manifest.copy);
  assert.deepEqual(again.counts, COUNTS, 'the counts describe the copy, not the live database');
  assert.deepEqual(copies(), [manifest.copy]);
});

test("a deploy's recent copy is reused and dated by its name, and one older than twelve hours is replaced", async () => {
  rmSync(backups, { recursive: true, force: true });
  mkdirSync(backups);
  const deployCopy = 'dictprop-20261115T010203Z-feedfeedfeedfeedfeedfeedfeedfeedfeedfeed.db';
  await db.backup(join(backups, deployCopy));

  const reused = prepare();
  assert.equal(reused.copy, deployCopy);
  // When the deploy started its copy, which is when the snapshot was taken.
  assert.equal(reused.createdAt, '2026-11-15T01:02:03.000Z');
  assert.equal(reused.counts.items, 3);

  const thirteenHoursAgo = (Date.now() - 13 * 60 * 60 * 1_000) / 1_000;
  utimesSync(join(backups, deployCopy), thirteenHoursAgo, thirteenHoursAgo);
  const replaced = prepare();
  assert.match(replaced.copy, /^pre-offsite-\d{8}T\d{6}Z\.db$/);
  assert.deepEqual(copies(), [replaced.copy]);
  assert.equal(existsSync(join(backups, deployCopy)), false);
});
