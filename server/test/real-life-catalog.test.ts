import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import {
  getRealLifeCatalogSentence,
  getRealLifeCatalogSentenceCount,
  getRealLifeCatalogSummaries,
} from '../src/real-life-catalog.js';
import { createRealLifeRoutes } from '../src/routes/real-life.js';

const firstSentenceId = 'career-conversations:rapport-and-small-talk:01';

test('Real Life catalog contains three substantial, stable collections', () => {
  const summaries = getRealLifeCatalogSummaries();
  assert.deepEqual(
    summaries.map(summary => [summary.id, summary.sentenceCount]),
    [
      ['career-conversations', 234],
      ['daily-shopping', 252],
      ['executive-communication', 234],
    ],
  );
  assert.equal(getRealLifeCatalogSentenceCount(), 720);
  const sentence = getRealLifeCatalogSentence(firstSentenceId);
  assert.equal(sentence?.focus, 'unplug');
  assert.match(sentence?.text || '', /unplug/);
  assert.equal(getRealLifeCatalogSentence('career-conversations:missing:01'), undefined);
});

test('Real Life route exposes catalog metadata without a generation endpoint', async () => {
  const app = new Hono().route('/api', createRealLifeRoutes());

  let response = await app.request('/api/real-life');
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json() as any).collections.map((collection: any) => collection.sentenceCount),
    [234, 252, 234],
  );

  response = await app.request(`/api/real-life/sentences/${encodeURIComponent(firstSentenceId)}/prepare`, {
    method: 'POST',
  });
  assert.equal(response.status, 404);
});
