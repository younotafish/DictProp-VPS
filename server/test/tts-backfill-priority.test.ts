import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionBackfillTexts, retryBackfillOperation } from '../src/routes/tts.js';

test('TTS backfill keeps product catalogs ahead of the general library', () => {
  const queue = partitionBackfillTexts(
    ['{{Catalog first}}', 'Shared sentence', ''],
    ['Library later', '[[Shared sentence]]', 'Library later', 'Final backlog item'],
  );

  assert.deepEqual(queue.catalog, ['Catalog first', 'Shared sentence']);
  assert.deepEqual(queue.library, ['Library later', 'Final backlog item']);
});

test('TTS backfill retries transient item failures without counting a successful retry as failed', async () => {
  let calls = 0;
  const result = await retryBackfillOperation(async () => {
    calls++;
    if (calls < 3) throw new Error('temporary upstream failure');
  }, 3, 0);

  assert.deepEqual(result, { succeeded: true, attempts: 3 });
  assert.equal(calls, 3);
});

test('TTS backfill reports a final failure after exhausting bounded retries', async () => {
  let calls = 0;
  const result = await retryBackfillOperation(async () => {
    calls++;
    throw new Error('persistent upstream failure');
  }, 3, 0);

  assert.equal(result.succeeded, false);
  assert.equal(result.attempts, 3);
  assert.match(String(result.error), /persistent upstream failure/);
  assert.equal(calls, 3);
});
