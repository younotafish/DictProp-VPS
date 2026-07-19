import { serve } from '@hono/node-server';
import { env } from './env.js';
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

// Full-corpus TTS backfill remains available through POST /api/tts/backfill. Do not start it on boot:
// model calls, alignment, and ffmpeg work can monopolize the 1-vCPU VPS immediately after a deploy.
