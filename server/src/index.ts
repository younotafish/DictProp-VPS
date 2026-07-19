import { serve } from '@hono/node-server';
import { env } from './env.js';
import { migrateInlineImages, migrateLegacyProjects } from './db.js';
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

// Run large SQLite migrations in the BACKGROUND, after the port is open. Both are resumable and
// yield between small transactions so health/reads stay responsive on the one-CPU VPS.
setTimeout(() => {
  void (async () => {
    try {
      await migrateLegacyProjects();
      console.log('[migrate] legacy project pass complete');
      await migrateInlineImages();
      console.log('[migrate] item_images pass complete');
    } catch (e) {
      console.error('[migrate] background migration failed (will retry next boot):', e);
    }
  })();
}, 500);

// Backfill TTS audio + word timings for every saved sentence in the BACKGROUND, server-side, so the
// client never needs to stay open. Idempotent + resumable (skips clips that are already complete).
// Delayed so boot + the image migration settle first; low concurrency keeps the 1-vCPU box responsive.
setTimeout(() => {
  runBackfill().catch((e) => console.error('[tts] startup backfill failed:', e?.message));
}, 20_000);
