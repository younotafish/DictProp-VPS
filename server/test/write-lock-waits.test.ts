import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { srs } from './support/fixtures.js';
import { png } from './support/fs.js';
import { SERVER_DIR } from './support/paths.js';

const { applyReviewEvent, db, storeItemImage, undoReviewEvent, upsertItem, upsertMany } = await import('../src/db.js');

const USER = 'lock-user';
const HOLD_MS = 300;
const vocab = (id: string, updatedAt = 1) =>
  ({ type: 'vocab', data: { id, word: id }, srs: srs(id, 'vocab'), savedAt: 1, updatedAt });

/**
 * Runs `write` while another process (an importer, in production) holds the database's write lock, and returns
 * how long the write waited. The other process commits after HOLD_MS.
 */
async function whileLocked<T>(write: () => T): Promise<{ result: T; waitedMs: number }> {
  const holder = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(join(process.env.DATA_DIR!, 'dictprop.db'))});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('lock-holder', 1)").run();
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${HOLD_MS});
  `], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve(); });
    holder.once('exit', code => reject(new Error(`lock holder exited ${code} before locking`)));
  });
  const start = Date.now();
  try {
    return { result: write(), waitedMs: Date.now() - start };
  } finally {
    await exited;
  }
}

test('a save waits for an importer\'s write lock instead of failing with SQLITE_BUSY', async () => {
  upsertItem(vocab('lock-saved'), USER);
  const { result, waitedMs } = await whileLocked(() => upsertItem(vocab('lock-saved', 2), USER));
  assert.equal(result.conflicted, false);
  assert.ok(waitedMs >= HOLD_MS / 2, `waited ${waitedMs} ms`);

  const batch = await whileLocked(() => upsertMany([vocab('lock-batch-a'), vocab('lock-batch-b')], USER));
  assert.deepEqual(Object.keys(batch.result.revisions).sort(), ['lock-batch-a', 'lock-batch-b']);
});

test('a review, its undo and an image upload wait for the write lock too', async () => {
  upsertItem(vocab('lock-reviewed'), USER);
  const event = {
    id: 'lock-review', itemId: 'lock-reviewed', itemType: 'vocab' as const, reviewedAt: Date.now(), previousStep: 0, nextStep: 1,
  };
  assert.equal((await whileLocked(() => applyReviewEvent(event, [event.itemId], USER))).result?.applied, true);
  assert.equal((await whileLocked(() => undoReviewEvent(event.id, USER))).result?.undone, true);
  assert.equal((await whileLocked(() => storeItemImage('lock-reviewed', png('lock'), 'image/png', USER))).result, 'stored');
});

test('an importer can still run these writes inside its own transaction', () => {
  const importChunk = db.transaction(() => {
    upsertItem(vocab('lock-nested'), USER);
    return upsertMany([vocab('lock-nested-batch')], USER).revisions['lock-nested-batch'];
  });
  assert.ok(importChunk.immediate() > 0);
  // Scripts call the variants of the exported transactions directly.
  assert.equal(typeof upsertMany.immediate, 'function');
  assert.equal(typeof upsertMany.deferred, 'function');
});
