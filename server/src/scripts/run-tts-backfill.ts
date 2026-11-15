// The scheduled backfill: .github/workflows/tts-backfill.yml starts it detached inside the app container. It shares the
// backfill lock with the web server's runs, so it starts only when no run is going, and prints the status at the end
// (or, when another run holds the lock, the status that run last published).
import { readFile } from 'node:fs/promises';
import { BACKFILL_STATUS_PATH, createBackfill } from '../tts/backfill.js';
import { createClipStore, defaultClipDependencies } from '../tts/clips.js';

const backfill = createBackfill({ clips: createClipStore(defaultClipDependencies), owner: 'worker' });
const run = await backfill.start();
if (run) {
  await run.finished;
  process.stdout.write(`${JSON.stringify(backfill.status())}\n`);
} else {
  const existing = await readFile(BACKFILL_STATUS_PATH, 'utf8').catch(() => '{}');
  process.stdout.write(`${existing.trim()}\n`);
}
