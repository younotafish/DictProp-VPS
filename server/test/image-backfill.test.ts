import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectImageBackfillTargets,
  createImageBackfillManager,
  type ImageBackfillStatus,
} from '../src/image-backfill.js';

const generatedImage = { data: Buffer.from('image'), mimeType: 'image/png' as const };

async function waitForCompletion(getStatus: () => ImageBackfillStatus): Promise<ImageBackfillStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = getStatus();
    if (!status.running) return status;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Image backfill did not complete');
}

test('collectImageBackfillTargets respects ownership scope and existing images', () => {
  const items = [
    { type: 'vocab', project: 'alpha', data: { id: 'one', imagePrompt: 'one prompt' } },
    { type: 'vocab', project: 'alpha', data: { id: 'done', imagePrompt: 'done prompt', imageUrl: 'server:has_image' } },
    { type: 'vocab', project: 'beta', data: { id: 'two', imagePrompt: 'two prompt' } },
    { type: 'vocab', project: 'alpha', isArchived: true, data: { id: 'archived', imagePrompt: 'skip' } },
    {
      type: 'phrase', project: 'alpha', data: {
        id: 'phrase',
        vocabs: [
          { id: 'nested', imagePrompt: 'nested prompt' },
          { id: 'one', imagePrompt: 'duplicate image id' },
        ],
      },
    },
  ];

  assert.deepEqual(collectImageBackfillTargets(items, { project: 'alpha' }), [
    { imageId: 'one', prompt: 'one prompt' },
    { imageId: 'nested', prompt: 'nested prompt' },
  ]);
  assert.deepEqual(collectImageBackfillTargets(items, { itemIds: ['two'] }), [
    { imageId: 'two', prompt: 'two prompt' },
  ]);
});

test('image backfill retries transient failures, stays serialized, and saves every success', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const saved: string[] = [];
  const manager = createImageBackfillManager({
    loadItems: () => [
      { type: 'vocab', data: { id: 'first', imagePrompt: 'first prompt' } },
      { type: 'vocab', data: { id: 'second', imagePrompt: 'second prompt' } },
    ],
    generateImage: async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      if (calls === 1) throw Object.assign(new Error('temporary failure'), { code: 'UPSTREAM_ERROR' });
      return generatedImage;
    },
    saveImage: (_userId, imageId) => { saved.push(imageId); return true; },
    delay: async () => {},
    retryDelaysMs: [0],
    interItemDelayMs: 0,
  });

  assert.equal(manager.start('user-a').running, true);
  const status = await waitForCompletion(() => manager.getStatus('user-a'));
  assert.equal(maxActive, 1);
  assert.equal(calls, 3);
  assert.deepEqual(saved, ['first', 'second']);
  assert.deepEqual(
    { total: status.total, done: status.done, generated: status.generated, failed: status.failed },
    { total: 2, done: 2, generated: 2, failed: 0 },
  );
});

test('image backfill stops on quota exhaustion without pretending remaining work completed', async () => {
  const manager = createImageBackfillManager({
    loadItems: () => [
      { type: 'vocab', data: { id: 'first', imagePrompt: 'first prompt' } },
      { type: 'vocab', data: { id: 'second', imagePrompt: 'second prompt' } },
    ],
    generateImage: async () => {
      throw Object.assign(new Error('quota exhausted'), { code: 'QUOTA_EXCEEDED' });
    },
    saveImage: () => true,
    delay: async () => {},
    retryDelaysMs: [],
    interItemDelayMs: 0,
  });

  manager.start('user-a');
  const status = await waitForCompletion(() => manager.getStatus('user-a'));
  assert.equal(status.stoppedReason, 'quota_exceeded');
  assert.equal(status.done, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.total - status.done, 1);
});

test('image backfill stops after repeated provider failures', async () => {
  const manager = createImageBackfillManager({
    loadItems: () => ['first', 'second', 'third', 'fourth'].map(id => ({
      type: 'vocab', data: { id, imagePrompt: `${id} prompt` },
    })),
    generateImage: async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'UPSTREAM_ERROR' });
    },
    saveImage: () => true,
    delay: async () => {},
    retryDelaysMs: [],
    interItemDelayMs: 0,
  });

  manager.start('user-a');
  const status = await waitForCompletion(() => manager.getStatus('user-a'));
  assert.equal(status.stoppedReason, 'provider_error');
  assert.equal(status.done, 3);
  assert.equal(status.failed, 3);
  assert.equal(status.total - status.done, 1);
});

test('image backfill cancellation stops after the in-flight image', async () => {
  let finishFirst!: () => void;
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  const saved: string[] = [];
  const manager = createImageBackfillManager({
    loadItems: () => [
      { type: 'vocab', data: { id: 'first', imagePrompt: 'first prompt' } },
      { type: 'vocab', data: { id: 'second', imagePrompt: 'second prompt' } },
    ],
    generateImage: async () => { await first; return generatedImage; },
    saveImage: (_userId, imageId) => { saved.push(imageId); return true; },
    delay: async () => {},
    retryDelaysMs: [],
    interItemDelayMs: 0,
  });

  manager.start('user-a');
  manager.cancel('user-a');
  finishFirst();
  const status = await waitForCompletion(() => manager.getStatus('user-a'));
  assert.equal(status.stoppedReason, 'cancelled');
  assert.equal(status.done, 1);
  assert.deepEqual(saved, ['first']);
});
