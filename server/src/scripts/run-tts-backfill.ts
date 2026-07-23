import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { getBackfillStatus, runBackfill } from '../routes/tts.js';

const lockPath = join(env.DATA_DIR, 'tts-backfill.lock');
const statusPath = join(env.DATA_DIR, 'tts-backfill-status.json');
const staleAfterMs = 5 * 60 * 1_000;

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < staleAfterMs || attempt > 0) return null;
      await unlink(lockPath).catch(() => {});
    }
  }
  return null;
}

const lock = await acquireLock();
if (!lock) {
  const existing = await readFile(statusPath, 'utf8').catch(() => '{}');
  process.stdout.write(`${existing.trim()}\n`);
  process.exit(0);
}

const persist = async () => {
  const payload = { ...getBackfillStatus(), workerPid: process.pid, heartbeatAt: Date.now() };
  await writeFile(lockPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
};
const heartbeat = setInterval(() => { void persist(); }, 30_000);
try {
  await persist();
  await runBackfill();
  await persist();
} finally {
  clearInterval(heartbeat);
  await lock.close().catch(() => {});
  await unlink(lockPath).catch(() => {});
}
