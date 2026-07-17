import { serve } from '@hono/node-server';
import { env } from './env.js';
import { migrateInlineImages } from './db.js';
import { runBackfill } from './routes/tts.js';
import { createApp } from './app.js';

const app = createApp();

console.log(`DictProp server starting on port ${env.PORT}...`);

const server = serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`Server running at http://localhost:${env.PORT}`);

let shuttingDown = false;
function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason}, closing HTTP server...`);
  server.close((error) => {
    if (error) {
      console.error('Failed to close HTTP server:', error);
      exitCode = 1;
    }
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM received'));
process.once('SIGINT', () => shutdown('SIGINT received'));
process.once('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  shutdown('Uncaught exception', 1);
});
process.once('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
  shutdown('Unhandled rejection', 1);
});

// Migrate inline base64 images → item_images in the BACKGROUND, after the port is open.
// Runs in event-loop-yielding chunks so health/reads stay responsive; resumes each boot
// until no inline images remain. A short delay lets the listener bind first.
setTimeout(() => {
  migrateInlineImages()
    .then(() => console.log('[migrate] item_images pass complete'))
    .catch((e) => console.error('[migrate] item_images failed (will retry next boot):', e));
}, 500);

// Backfill TTS audio + word timings for every saved sentence in the BACKGROUND, server-side, so the
// client never needs to stay open. Idempotent + resumable (skips clips that are already complete).
// Delayed so boot + the image migration settle first; low concurrency keeps the 1-vCPU box responsive.
setTimeout(() => {
  runBackfill().catch((e) => console.error('[tts] startup backfill failed:', e?.message));
}, 20_000);
