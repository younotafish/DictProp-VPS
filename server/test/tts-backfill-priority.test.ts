import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionBackfillTexts } from '../src/routes/tts.js';

test('TTS backfill keeps the Real Life catalog ahead of the general library', () => {
  const queue = partitionBackfillTexts(
    ['{{Catalog first}}', 'Shared sentence', ''],
    ['Library later', '[[Shared sentence]]', 'Library later', 'Final backlog item'],
  );

  assert.deepEqual(queue.catalog, ['Catalog first', 'Shared sentence']);
  assert.deepEqual(queue.library, ['Library later', 'Final backlog item']);
});
