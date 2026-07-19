import { serve } from '@hono/node-server';
import { env } from './env.js';
import { migrateInlineImages, migrateLegacyProjects } from './db.js';
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

// Full-corpus TTS backfill remains available through POST /api/tts/backfill. Do not start it on boot:
// model calls, alignment, and ffmpeg work can monopolize the 1-vCPU VPS immediately after a deploy.
