import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, request, type Server } from 'node:http';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { createShutdown, drainHttpServer, SHUTDOWN_DEADLINE_MS } from '../src/shutdown.js';
import { repoPath } from './support/paths.js';

/** A shutdown whose server, database and exit only record what is done to them. */
function harness(deadlineMs?: number) {
  const steps: string[] = [];
  let endDrain: ((error?: Error) => void) | undefined;
  const shutdown = createShutdown({
    closeServer: done => {
      steps.push('close server');
      endDrain = done;
    },
    closeDatabase: () => {
      steps.push('close database');
    },
    exit: code => {
      steps.push(`exit ${code}`);
    },
    deadlineMs,
  });
  return { steps, shutdown, endDrain: (error?: Error) => endDrain?.(error) };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('once the requests in flight finish, the database closes and the process exits with its code', async () => {
  const signal = harness(20);
  signal.shutdown('SIGTERM received');
  assert.deepEqual(signal.steps, ['close server']);
  signal.endDrain();
  assert.deepEqual(signal.steps, ['close server', 'close database', 'exit 0']);
  // The deadline was called off.
  await pause(40);
  assert.deepEqual(signal.steps, ['close server', 'close database', 'exit 0']);

  const fatal = harness();
  fatal.shutdown('Uncaught exception', 1);
  fatal.endDrain();
  assert.deepEqual(fatal.steps, ['close server', 'close database', 'exit 1']);

  const failedClose = harness();
  failedClose.shutdown('SIGTERM received');
  failedClose.endDrain(new Error('Server is not running.'));
  assert.deepEqual(failedClose.steps, ['close server', 'close database', 'exit 1']);
});

test('requests still running at the deadline end the process with exit code 1', async () => {
  const stuck = harness(10);
  stuck.shutdown('SIGTERM received');
  await pause(40);
  assert.deepEqual(stuck.steps, ['close server', 'exit 1']);
});

test('a second signal or a fatal error during the drain starts nothing new', () => {
  const twice = harness();
  twice.shutdown('SIGTERM received');
  twice.shutdown('SIGINT received');
  twice.shutdown('Unhandled rejection', 1);
  twice.endDrain();
  assert.deepEqual(twice.steps, ['close server', 'close database', 'exit 0']);
});

/**
 * A real server whose GET /held answers once release() is called, a client that keeps one connection open between
 * requests as Caddy does, and a shutdown that drains the server with drainHttpServer.
 */
async function liveServer(sweepMs?: number) {
  let arrive!: () => void;
  const held = new Promise<void>(resolve => { arrive = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let server!: Server;
  const port = await new Promise<number>(resolve => {
    server = serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (incoming: Request) => {
        if (new URL(incoming.url).pathname === '/held') {
          arrive();
          await released;
        }
        return new Response('ok');
      },
    }, info => resolve(info.port)) as Server;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const get = (path: string) => new Promise<{ body: string; connection: string | undefined }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, agent }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ body, connection: response.headers.connection }));
    }).on('error', reject).end();
  });
  const steps: string[] = [];
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const shutdown = createShutdown({
    closeServer: done => drainHttpServer(server, done, sweepMs),
    closeDatabase: () => {
      steps.push('close database');
    },
    exit: code => {
      steps.push(`exit ${code}`);
      exited();
    },
    // Well short of the 5 s a kept-alive connection would otherwise stay open.
    deadlineMs: 2_000,
  });
  return { held, release, get, steps, exit, shutdown, close: () => agent.destroy() };
}

test('a drain closes a kept-alive connection as soon as its request finishes, so the database closes first', async () => {
  const live = await liveServer();
  const inFlight = live.get('/held');
  await live.held;
  live.shutdown('SIGTERM received');
  live.release();
  // The request came before the drain, so its response keeps the connection; the drain closes it once idle.
  assert.deepEqual(await inFlight, { body: 'ok', connection: 'keep-alive' });
  await live.exit;
  assert.deepEqual(live.steps, ['close database', 'exit 0']);
  live.close();
});

test('a request that comes on a kept-alive connection during the drain is answered, and closes that connection', async () => {
  // No idle sweep before the deadline, so only the response's own Connection: close can end the drain.
  const live = await liveServer(60_000);
  const inFlight = live.get('/held');
  await live.held;
  live.shutdown('SIGTERM received');
  // The client sends this on the same connection as soon as the request in flight is answered.
  const during = live.get('/');
  live.release();
  assert.deepEqual(await inFlight, { body: 'ok', connection: 'keep-alive' });
  assert.deepEqual(await during, { body: 'ok', connection: 'close' });
  await live.exit;
  assert.deepEqual(live.steps, ['close database', 'exit 0']);
  live.close();
});

test('the forced exit comes before Docker\'s SIGKILL', () => {
  const compose = readFileSync(repoPath('docker-compose.yml'), 'utf8');
  const graceSeconds = Number(compose.match(/^\s*stop_grace_period:\s*(\d+)s\s*$/m)?.[1]);
  assert.ok(graceSeconds > 0, 'docker-compose.yml sets stop_grace_period in seconds');
  // Half a second is left for the exit itself.
  assert.ok(SHUTDOWN_DEADLINE_MS <= graceSeconds * 1000 - 500, `${SHUTDOWN_DEADLINE_MS} ms vs ${graceSeconds} s`);
});
