import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { acquireLock, type LockOwner } from '../src/tts/lock.js';

const STALE_AFTER_MS = 5 * 60_000;
// fs/promises as lock.ts imports it: a function replaced here, then synced, is the one lock.ts calls.
const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');

/** Replaces fs/promises functions for lock.ts until the test ends. */
function patchFs(t: TestContext, replacements: Partial<Record<'rename' | 'stat', unknown>>) {
  const originals = { rename: fsp.rename, stat: fsp.stat };
  Object.assign(fsp, replacements);
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fsp, originals);
    syncBuiltinESMExports();
  });
  return originals;
}

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'tts-lock-')), 'tts-backfill.lock');

function writeLock(path: string, holder: { owner: LockOwner; pid: number }) {
  writeFileSync(path, JSON.stringify({ ...holder, startedAt: Date.now() }));
}

// What the lock's folder holds besides the lock, such as a lock moved aside and never removed.
const leftovers = (path: string) => readdirSync(dirname(path)).filter(name => name !== basename(path));

// The pid of a process that has exited.
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// Holds the lock's first rename until the test releases it, as when a takeover judged the lock abandoned, then lagged.
function holdFirstRename(t: TestContext, path: string) {
  const reached = deferred();
  const released = deferred();
  let held = false;
  const { rename } = patchFs(t, {
    rename: async (from: string, to: string) => {
      if (from === path && !held) {
        held = true;
        reached.release();
        await released.promise;
      }
      return rename(from, to);
    },
  });
  return { reached: reached.promise, release: released.release };
}

test('a lock made while this process moves the abandoned one aside goes back, and this process gives up', async (t) => {
  const path = lockPath();
  writeLock(path, { owner: 'worker', pid: deadPid() });
  const held = holdFirstRename(t, path);
  const taking = acquireLock(path, 'server', STALE_AFTER_MS);
  await held.reached;
  // Meanwhile the worker took the same abandoned lock over and made its own.
  rmSync(path);
  writeLock(path, { owner: 'worker', pid: process.ppid });
  held.release();
  assert.equal(await taking, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.ppid);
  assert.deepEqual(leftovers(path), []);
});

test('of two takeovers of one abandoned lock in this process, the late one leaves the other its lock', async (t) => {
  const path = lockPath();
  writeLock(path, { owner: 'worker', pid: deadPid() });
  const held = holdFirstRename(t, path);
  const late = acquireLock(path, 'worker', STALE_AFTER_MS);
  await held.reached;
  const first = await acquireLock(path, 'server', STALE_AFTER_MS);
  assert.ok(first);
  held.release();
  assert.equal(await late, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, 'server');
  await first.release();
  assert.equal(existsSync(path), false);
  assert.deepEqual(leftovers(path), []);
});

test('a lock released while this process looks at it, and taken at once by another, is left to that one', async (t) => {
  const path = lockPath();
  writeLock(path, { owner: 'server', pid: process.ppid });
  let looked = false;
  const { stat } = patchFs(t, {
    stat: async (file: string) => {
      if (file !== path || looked) return stat(file);
      looked = true;
      rmSync(path); // its holder lets go, so this process finds no lock...
      try {
        return await stat(file);
      } finally {
        writeLock(path, { owner: 'worker', pid: process.ppid }); // ...and the worker takes it straight away
      }
    },
  });
  assert.equal(await acquireLock(path, 'server', STALE_AFTER_MS), null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, 'worker');
  assert.deepEqual(leftovers(path), []);
});
