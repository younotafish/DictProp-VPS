import assert from 'node:assert/strict';
import test from 'node:test';
import { saveItems } from '../../services/api.ts';
import { HttpError } from '../../services/http.ts';
import type { StoredItem } from '../../types.ts';

// saveItems only needs fetch; each test scripts the server's answer to one PUT /api/items batch.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const item = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id } as StoredItem['data'],
  savedAt: 1,
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
});

function serve(answer: (batch: StoredItem[], call: number) => Response) {
  const batches: string[][] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    const batch = JSON.parse(String(init.body)) as StoredItem[];
    batches.push(batch.map(entry => entry.data.id));
    return answer(batch, batches.length);
  }) as typeof fetch;
  return batches;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const saved = (batch: StoredItem[]) => json({ revisions: Object.fromEntries(batch.map(entry => [entry.data.id, 7])), canonical: [] });

test('an item the server refuses is isolated, and the rest of its batch still saves', async () => {
  const batches = serve(batch => batch.some(entry => entry.data.id === 'bad')
    ? json({ error: 'Item data is too large' }, 400)
    : saved(batch));
  const result = await saveItems(['a', 'b', 'bad', 'c', 'd'].map(item));

  assert.deepEqual([...result.revisions.keys()].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...(result.rejected ?? [])], [['bad', 'Item data is too large']]);
  assert.equal(result.error, undefined);
  assert.deepEqual(batches[0], ['a', 'b', 'bad', 'c', 'd']);
  assert.ok(batches.length <= 1 + 2 * Math.ceil(Math.log2(5)), `split into few requests (${batches.length})`);
});

test('a push that stops partway still reports what the earlier batches saved', async () => {
  const many = Array.from({ length: 250 }, (_, index) => item(`item-${index}`));
  serve((batch, call) => call === 1 ? saved(batch) : json({ error: 'Server unavailable' }, 503));
  const result = await saveItems(many);
  assert.equal(result.revisions.size, 200);
  assert.ok(result.error instanceof HttpError && result.error.status === 503);

  // Nothing saved: the failure is the push's own.
  serve(() => json({ error: 'Server unavailable' }, 503));
  await assert.rejects(saveItems(many), (error: unknown) => error instanceof HttpError && error.status === 503);
});
