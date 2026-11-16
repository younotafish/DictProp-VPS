// The backfill lock: one backfill at a time across the web server and the detached worker
// (scripts/run-tts-backfill.ts), so the two-core box never synthesizes and aligns the same clips twice. Clips stay
// correct without it, since publishOnce keeps the first stored copy; the lock saves the duplicated work.
import { randomUUID } from 'crypto';
import { link, open, readFile, rename, stat, unlink, type FileHandle } from 'fs/promises';

/** Who holds the lock: the web server (a request from the app) or the detached worker (the scheduled workflow). */
export type LockOwner = 'server' | 'worker';

export interface HeldLock {
  /** Marks the lock as live; one left untouched for its stale time may be taken over. */
  touch(): Promise<void>;
  /** Removes the lock, unless another process has already taken it over. */
  release(): Promise<void>;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The locks this process holds. A process never takes over its own lock: from outside, a lock it holds looks like one
// an earlier process with its pid left.
const heldPaths = new Set<string>();

async function readHolder(path: string): Promise<{ pid?: unknown } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// Whether the lock file at `file`, one this process doesn't hold, may be taken over: its holder stopped touching it, or
// its holder's process is gone. The web server and the detached worker run in the same container, so each sees the
// other's pid; a lock under this process's own pid was left by an earlier process (a restarted container's server is
// PID 1 again). A lock whose holder can't be read, such as one from before holders were recorded or one whose holder
// hasn't written itself in yet, waits until it goes stale. Null when there is no file.
async function isAbandoned(file: string, staleAfterMs: number): Promise<boolean | null> {
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (Date.now() - modifiedAt >= staleAfterMs) return true;
  const pid = (await readHolder(file))?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && (pid === process.pid || !isProcessRunning(pid));
}

// Removes the abandoned lock at `path`, moving it aside first: of several processes taking it over at once, one rename
// succeeds and the others find it gone. A rename that comes a moment late can catch the lock another process has just
// made in its place instead, so the lock that moved is judged again, and a live one goes back; false then. Only the web
// server and the worker take this lock, so no third process takes the path in the moment it is free.
async function takeOver(path: string, staleAfterMs: number): Promise<boolean> {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; // another process moved it first
    throw error;
  }
  const live = heldPaths.has(path) || (await isAbandoned(aside, staleAfterMs).catch(() => false)) === false;
  if (live) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
  return !live;
}

async function hold(path: string, handle: FileHandle, owner: LockOwner): Promise<HeldLock> {
  // Who holds it, for a process deciding whether a lock it finds was left by one that is gone.
  await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, startedAt: Date.now() })}\n`).catch(() => {});
  const { ino } = await handle.stat();
  heldPaths.add(path);
  return {
    touch: async () => {
      const now = new Date();
      await handle.utimes(now, now);
    },
    release: async () => {
      await handle.close().catch(() => {});
      // Unlink only this process's lock: one that judged it abandoned may have replaced it.
      const current = await stat(path).catch(() => null);
      if (current?.ino === ino) await unlink(path).catch(() => {});
      heldPaths.delete(path);
    },
  };
}

/** Takes the lock at `path`, or resolves null while another live process holds it. */
export async function acquireLock(path: string, owner: LockOwner, staleAfterMs: number): Promise<HeldLock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 0 || heldPaths.has(path)) return null;
      const abandoned = await isAbandoned(path, staleAfterMs);
      if (abandoned === false || (abandoned && !(await takeOver(path, staleAfterMs)))) return null;
      continue; // released meanwhile, or taken over: open it again
    }
    return hold(path, handle, owner);
  }
  return null;
}
