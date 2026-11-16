import assert from 'node:assert/strict';
import test from 'node:test';
import { runPool } from '../src/shared/pool.js';

/** Lets every pending callback and promise reaction run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** A `work` whose calls each wait until the test finishes them; it records each call's item and index, in order. */
function controlledWork() {
  const started: Array<[string, number]> = [];
  const running = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let mostRunning = 0;
  const work = (item: string, index: number) => new Promise<void>((resolve, reject) => {
    started.push([item, index]);
    running.set(item, { resolve, reject });
    mostRunning = Math.max(mostRunning, running.size);
  });
  /** Ends a running item, rejecting with `error` when given one, and lets the pool react. */
  const finish = async (item: string, error?: Error) => {
    const call = running.get(item);
    assert.ok(call, `${item} is running`);
    running.delete(item);
    if (error) call.reject(error);
    else call.resolve();
    await settle();
  };
  return { work, started, finish, startedItems: () => started.map(([item]) => item), mostRunning: () => mostRunning };
}

test('items start in order with their index, at most `concurrency` at once, each as soon as a worker is free', async () => {
  const { work, started, finish, startedItems, mostRunning } = controlledWork();
  let finished = false;
  const pool = runPool(['a', 'b', 'c', 'd', 'e'], 2, work).then(() => { finished = true; });
  await settle();
  assert.deepEqual(startedItems(), ['a', 'b']);

  // The later item finishing first frees its worker for the next one.
  await finish('b');
  assert.deepEqual(startedItems(), ['a', 'b', 'c']);
  await finish('a');
  await finish('c');
  assert.deepEqual(startedItems(), ['a', 'b', 'c', 'd', 'e']);
  await finish('e');
  assert.equal(finished, false, 'the pool waits for every item');
  await finish('d');
  await pool;
  assert.deepEqual(started, [['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4]]);
  assert.equal(mostRunning(), 2);
});

test('a concurrency above the item count starts every item at once, and an empty list resolves at once', async () => {
  const { work, finish, startedItems } = controlledWork();
  const pool = runPool(['a', 'b'], 5, work);
  await settle();
  assert.deepEqual(startedItems(), ['a', 'b']);
  await finish('a');
  await finish('b');
  await pool;

  let calls = 0;
  const empty = runPool([], 5, async () => { calls++; }).then(() => 'resolved');
  assert.equal(await Promise.race([empty, settle().then(() => 'pending')]), 'resolved');
  assert.equal(calls, 0);
});

test('once the signal aborts no further item starts, and the pool ends when the running items finish', async () => {
  const controller = new AbortController();
  const { work, finish, startedItems } = controlledWork();
  let finished = false;
  const pool = runPool(['a', 'b', 'c', 'd', 'e'], 2, work, controller.signal).then(() => { finished = true; });
  await settle();
  await finish('a');
  assert.deepEqual(startedItems(), ['a', 'b', 'c']);

  controller.abort();
  await finish('b');
  assert.equal(finished, false, 'c is still running');
  await finish('c');
  assert.deepEqual(startedItems(), ['a', 'b', 'c']);
  await pool;

  let calls = 0;
  await runPool(['a'], 2, async () => { calls++; }, AbortSignal.abort());
  assert.equal(calls, 0, 'an already aborted signal starts nothing');
});

test('an item that rejects rejects the pool at once, and the other workers go on with the remaining items', async () => {
  const { work, finish, startedItems } = controlledWork();
  const outcome = runPool(['a', 'b', 'c', 'd'], 2, work).then(() => 'resolved', (error: unknown) => error);
  await settle();
  const failure = new Error('b failed');
  await finish('b', failure);
  assert.equal(await Promise.race([outcome, settle().then(() => 'pending')]), failure, 'rejected while a still runs');

  // b's worker has stopped, so the rest run one at a time on a's.
  assert.deepEqual(startedItems(), ['a', 'b']);
  await finish('a');
  assert.deepEqual(startedItems(), ['a', 'b', 'c']);
  await finish('c');
  assert.deepEqual(startedItems(), ['a', 'b', 'c', 'd']);
  await finish('d');
});
