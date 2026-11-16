import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { env, listenOptions } from './env.js';
import { createApp } from './app.js';
import { db } from './db.js';
import { createShutdown, drainHttpServer } from './shutdown.js';

const app = createApp();

console.log(`DictProp server starting on port ${env.PORT}...`);

// Without a createServer option, serve() makes a node:http server.
const server = serve({ fetch: app.fetch, ...listenOptions() }) as Server;

console.log(`Server running at http://localhost:${env.PORT}${env.DEV_AUTH_BYPASS ? ' (auth bypass, loopback only)' : ''}`);

const shutdown = createShutdown({
  closeServer: done => drainHttpServer(server, done),
  closeDatabase: () => db.close(),
  exit: code => process.exit(code),
});

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
// model calls, alignment, and ffmpeg work can monopolize the 2-vCPU VPS immediately after a deploy.
