import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerialLane } from '../../services/serialLane.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('tasks run one at a time, in the order they were handed in', async () => {
  const lane = createSerialLane();
  const events: string[] = [];
  let releaseFirst = () => {};
  const first = lane(async () => {
    events.push('first starts');
    await new Promise<void>(resolve => { releaseFirst = resolve; });
    events.push('first ends');
    return 1;
  });
  const second = lane(async () => {
    events.push('second starts');
    return 2;
  });

  await settle();
  assert.deepEqual(events, ['first starts'], 'the second task waits for the first');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first starts', 'first ends', 'second starts']);
});

test('a task that fails rejects only its own promise, and the next one still runs', async () => {
  const lane = createSerialLane();
  const failed = lane(async () => { throw new Error('push refused'); });
  const next = lane(async () => 'pulled');

  await assert.rejects(failed, /push refused/);
  assert.equal(await next, 'pulled');
});

test('a task that throws before returning its promise behaves the same', async () => {
  const lane = createSerialLane();
  const failed = lane((() => { throw new Error('thrown synchronously'); }) as () => Promise<never>);
  const next = lane(async () => 'still runs');

  await assert.rejects(failed, /thrown synchronously/);
  assert.equal(await next, 'still runs');
});
