import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createShutdown, SHUTDOWN_DEADLINE_MS } from '../src/shutdown.js';
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

test('the forced exit comes before Docker\'s SIGKILL', () => {
  const compose = readFileSync(repoPath('docker-compose.yml'), 'utf8');
  const graceSeconds = Number(compose.match(/^\s*stop_grace_period:\s*(\d+)s\s*$/m)?.[1]);
  assert.ok(graceSeconds > 0, 'docker-compose.yml sets stop_grace_period in seconds');
  // Half a second is left for the exit itself.
  assert.ok(SHUTDOWN_DEADLINE_MS <= graceSeconds * 1000 - 500, `${SHUTDOWN_DEADLINE_MS} ms vs ${graceSeconds} s`);
});
