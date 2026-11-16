import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { srs } from './support/fixtures.js';
import { createOwner, lastJsonLine, OWNER_EMAIL, runScript, saveItem } from './support/library.js';
import { startScript } from './support/scripts.js';

const { db, getItemById, upsertItem } = await import('../src/db.js');

const owner = createOwner();
const stored = (id: string) => getItemById(id, owner.id, false)!;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Gives a stored row a schedule the repair fixes and, when given one, a revision: 0 for a row from before revisions. */
function breakSchedule(id: string, revision?: number): void {
  db.prepare(`UPDATE items SET srs = json_set(srs, '$.stability', -1) WHERE id = ?`).run(id);
  if (revision !== undefined) db.prepare('UPDATE items SET revision = ? WHERE id = ?').run(revision, id);
}

// Pairs from the repair's SEMANTIC_DUPLICATE_GROUPS: the first card survives, the second is deleted, and sentences
// linked to the second's sense move to the first's.
const SEMANTIC_PAIRS = [
  ['6e7c13ab-f74f-49c5-90ac-bf28ec220c0b', '5b30ebf0-ebc8-4b9e-b039-480fbf97428a'],
  ['62f55785-4c98-4246-87a6-4dcd734033fb', '7eefb850-1d00-442f-86eb-8781c71e7695'],
] as const;

function saveSemanticPair([survivorId, loserId]: readonly [string, string]): void {
  saveItem(owner.id, survivorId, 'vocab', { word: 'placid', sense: 'calm and peaceful' });
  saveItem(owner.id, loserId, 'vocab', { word: 'placid', sense: 'not easily upset' });
}

/**
 * Runs the repair with --apply while `save`, standing in for a device, saves between the repair's read of the library
 * and its writes. The repair backs up the database just before it reads the library. The save starts as the backup
 * appears, inside a transaction that holds the write lock, and commits a second after the backup is complete: the
 * repair has read the library by then and is waiting for the lock.
 */
async function repairDuring(save: () => void) {
  const backups = join(process.env.DATA_DIR!, 'backups');
  rmSync(backups, { recursive: true, force: true });
  const child = startScript('repair-production-data', ['--apply'], { OWNER_GOOGLE_EMAIL: OWNER_EMAIL });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  // The copy is written as pre-repair-<time>.db.partial and renamed when complete.
  const backup = () => (existsSync(backups) ? readdirSync(backups) : []).find(name => name.startsWith('pre-repair-'));
  while (!backup() && child.exitCode === null) await pause(1);
  db.exec('BEGIN IMMEDIATE');
  try {
    save();
    while (backup()?.endsWith('.partial') && child.exitCode === null) await pause(1);
    await pause(1_000);
  } finally {
    db.exec('COMMIT');
  }
  return { status: await exited, stdout, stderr };
}

test('the repair writes a row stored before revisions existed like any other, and a sentence it relinks only once', () => {
  saveItem(owner.id, 'old-row', 'vocab', { word: 'serene' });
  breakSchedule('old-row', 0);
  const [survivorId, loserId] = SEMANTIC_PAIRS[0];
  saveSemanticPair(SEMANTIC_PAIRS[0]);
  // Linked to the sense that goes away, and with a broken schedule too: the write that relinks it fixes that as well.
  saveItem(owner.id, 'relinked', 'sentence', { text: 'A placid temper.', sourceWord: 'placid', sourceSense: 'not easily upset' });
  breakSchedule('relinked');

  const run = runScript('repair-production-data', ['--apply']);
  assert.equal(run.status, 0, run.stderr);
  const report = lastJsonLine(run.stdout);
  assert.deepEqual(report.invalidSrsIds, ['old-row']);
  assert.equal(report.relinkedSentenceCount, 1);
  assert.equal(stored('old-row').srs.stability, 0);
  assert.ok(stored('old-row').serverRevision! > 0);
  assert.equal(stored('relinked').data.sourceSense, 'calm and peaceful');
  assert.equal(stored('relinked').srs.stability, 0);
  assert.equal(stored(survivorId).isDeleted, undefined);
  assert.equal(stored(loserId).isDeleted, true);
});

test('a save made while the repair runs stops it before it writes anything, and the next run keeps the save', async () => {
  // A row stored before revisions existed, whose schedule the repair fixes, and a pair it consolidates. They are saved
  // before thousands of other rows, so the repair reads them first and spends far longer reading the rest than the
  // save takes to begin.
  saveItem(owner.id, 'raced-row', 'vocab', { word: 'lucid', definition: 'clear' });
  breakSchedule('raced-row', 0);
  const [survivorId, loserId] = SEMANTIC_PAIRS[1];
  saveSemanticPair(SEMANTIC_PAIRS[1]);
  const insert = db.prepare(`INSERT INTO items (id, type, data, srs, saved_at, updated_at, user_id, revision)
    VALUES (?, 'vocab', ?, ?, 1, 1000, ?, 1)`);
  db.transaction(() => {
    for (let index = 0; index < 20_000; index++) {
      const id = `filler-${index}`;
      insert.run(id, JSON.stringify({ id, word: `filler ${index}` }), JSON.stringify(srs(id, 'vocab')), owner.id);
    }
  })();
  const edit = (id: string, changes: Record<string, unknown>) => {
    const item = stored(id);
    upsertItem({ ...item, data: { ...item.data, ...changes }, updatedAt: Date.now() }, owner.id);
  };

  // A device edits the row whose schedule the repair fixes.
  const rowEdited = await repairDuring(() => edit('raced-row', { definition: 'edited on a device' }));
  assert.equal(rowEdited.status, 1, rowEdited.stdout);
  assert.match(rowEdited.stderr, /Item changed during repair: raced-row/);
  assert.equal(stored('raced-row').data.definition, 'edited on a device');
  assert.equal(stored('raced-row').srs.stability, -1);
  assert.equal(stored(loserId).isDeleted, undefined);

  // A device adds an example to the card the repair would delete.
  const loserEdited = await repairDuring(() => edit(loserId, { examples: ['A {{placid}} lake.'] }));
  assert.equal(loserEdited.status, 1, loserEdited.stdout);
  assert.match(loserEdited.stderr, new RegExp(`Item changed during repair: ${loserId}`));
  assert.equal(stored(loserId).isDeleted, undefined);

  // Run again, the repair starts from what is stored and keeps both saves.
  const rerun = runScript('repair-production-data', ['--apply']);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(stored('raced-row').data.definition, 'edited on a device');
  assert.equal(stored('raced-row').srs.stability, 0);
  assert.equal(stored(loserId).isDeleted, true);
  assert.deepEqual(stored(survivorId).data.examples, ['A {{placid}} lake.']);
});
