// The backfill lock: one backfill at a time across the web server and the detached worker
// (scripts/run-tts-backfill.ts), so the two-core box never synthesizes and aligns the same clips twice. Clips stay
// correct without it, since publishOnce keeps the first stored copy; the lock saves the duplicated work.
import { open, readFile, rename, stat, unlink, type FileHandle } from 'fs/promises';

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

// Whether a lock this process doesn't hold may be taken over: its holder stopped touching it, or its holder's process
// is gone. The web server and the detached worker run in the same container, so each sees the other's pid; a lock under
// this process's own pid was left by an earlier process (a restarted container's server is PID 1 again). A lock whose
// holder can't be read, such as one from before holders were recorded, waits until it goes stale.
async function isAbandoned(path: string, staleAfterMs: number): Promise<boolean> {
  if (heldPaths.has(path)) return false;
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; // released meanwhile: open it again
    throw error;
  }
  if (Date.now() - modifiedAt >= staleAfterMs) return true;
  const pid = (await readHolder(path))?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && (pid === process.pid || !isProcessRunning(pid));
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
      if (attempt > 0 || !(await isAbandoned(path, staleAfterMs))) return null;
      // Move an abandoned lock aside instead of deleting it: of several processes taking it over at once, one
      // rename succeeds and the others find it gone.
      const aside = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(path, aside);
        await unlink(aside).catch(() => {});
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
      }
      continue;
    }
    return hold(path, handle, owner);
  }
  return null;
}
