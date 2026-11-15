import assert from 'node:assert/strict';
import test from 'node:test';
import { AiError } from '../src/ai-client.js';
import { createBackfill, type BackfillTexts } from '../src/tts/backfill.js';
import { createClipStore, type ClipDependencies } from '../src/tts/clips.js';

const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

type ReduceBatch = (sentences: string[]) => Promise<Array<string | null>>;
const respellAll: ReduceBatch = async (sentences) => sentences.map(sentence => `${sentence} (batch)`);

// A backfill over the given sentences with synthesis, respelling and whisper replaced; every call is recorded.
function harness(texts: BackfillTexts, reduceBatch: ReduceBatch = respellAll) {
  const calls = { clear: [] as string[], casual: [] as string[], reduce: [] as string[], batches: [] as string[][], align: 0 };
  const deps: ClipDependencies = {
    synthClear: async (text) => { calls.clear.push(text); return Buffer.from(`ID3 clear ${text}`); },
    synthCasual: async (spoken) => { calls.casual.push(spoken); return Buffer.from(`ID3 casual ${spoken}`); },
    reduce: async (sentence) => { calls.reduce.push(sentence); return `${sentence} (casual)`; },
    align: async () => { calls.align++; return TIMING; },
  };
  const backfill = createBackfill({
    clips: createClipStore(deps),
    reduceBatch: async (sentences) => { calls.batches.push(sentences); return reduceBatch(sentences); },
    sentenceTexts: () => texts,
    retryDelayMs: 0,
  });
  const counts = () => {
    const { running, total, done, generated, failed } = backfill.status();
    return { running, total, done, generated, failed };
  };
  return { backfill, calls, counts };
}

test('a spent respelling balance stops the casual clips that need audio for the rest of the run, counted as failed', async () => {
  const { backfill, calls, counts } = harness(
    { catalog: ['Halt catalog one.', 'Halt catalog two.'], library: ['Halt library one.'] },
    async () => { throw new AiError('quota', 'Provider quota exhausted (402)'); },
  );
  await backfill.run();
  assert.equal(calls.batches.length, 1); // the catalog's batch; the library's casual clips never ask
  assert.deepEqual(calls.reduce, []);
  assert.deepEqual(calls.casual, []);
  assert.equal(calls.clear.length, 3);
  assert.deepEqual(counts(), { running: false, total: 6, done: 6, generated: 3, failed: 3 });
});

test('any other batch failure leaves each casual clip to be respelled on its own', async () => {
  const { backfill, calls, counts } = harness(
    { catalog: ['Fallback one.', 'Fallback two.'], library: [] },
    async () => { throw new Error('socket hang up'); },
  );
  await backfill.run();
  assert.deepEqual(calls.reduce.sort(), ['Fallback one.', 'Fallback two.']);
  assert.deepEqual(calls.casual.sort(), ['Fallback one. (casual)', 'Fallback two. (casual)']);
  assert.deepEqual(counts(), { running: false, total: 4, done: 4, generated: 4, failed: 0 });
});
