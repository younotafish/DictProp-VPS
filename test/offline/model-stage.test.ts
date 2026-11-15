import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  batchFiles,
  batchFingerprint,
  indexedResults,
  jitteredDelay,
  runCachedModelBatch,
  runPool,
  runSplittingBatches,
  stageSettings,
} from '../../scripts/offline/model-stage.mjs';
import { sha256 } from '../support/fs.ts';

type Lifecycle = { aborting: boolean; activeChildren: Set<unknown>; terminate: () => Promise<void> };

function lifecycle(): Lifecycle & { terminated: number } {
  const state = {
    aborting: false,
    activeChildren: new Set<unknown>(),
    terminated: 0,
    async terminate() {
      state.terminated++;
      state.aborting = true;
    },
  };
  return state;
}

function workDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-model-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('stage settings keep each stage default and clamp what the environment asks for', () => {
  assert.deepEqual(stageSettings({ defaultTimeoutMinutes: 40 }, {}), {
    timeoutMs: 40 * 60_000,
    retryDelayMs: 5_000,
    concurrency: 4,
  });
  assert.equal(stageSettings({ defaultTimeoutMinutes: 20 }, {}).timeoutMs, 20 * 60_000);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_TIMEOUT_MINUTES: '1' }).timeoutMs, 5 * 60_000);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_TIMEOUT_MINUTES: '90' }).timeoutMs, 60 * 60_000);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 20 }, { CODEX_TIMEOUT_MINUTES: 'soon' }).timeoutMs, 20 * 60_000);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_RETRY_DELAY_MS: '90000' }).retryDelayMs, 60_000);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_RETRY_DELAY_MS: '0' }).retryDelayMs, 0);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_CONCURRENCY: '40' }).concurrency, 16);
  assert.equal(stageSettings({ defaultTimeoutMinutes: 40 }, { CODEX_CONCURRENCY: '0' }).concurrency, 1);

  // The judge reads its own variable first and has a lower ceiling.
  const judge = { defaultTimeoutMinutes: 20, maxConcurrency: 8, concurrencyVariables: ['CODEX_IMAGE_CONCURRENCY', 'CODEX_CONCURRENCY'] };
  assert.equal(stageSettings(judge, { CODEX_IMAGE_CONCURRENCY: '2', CODEX_CONCURRENCY: '6' }).concurrency, 2);
  assert.equal(stageSettings(judge, { CODEX_IMAGE_CONCURRENCY: '', CODEX_CONCURRENCY: '6' }).concurrency, 6);
  assert.equal(stageSettings(judge, { CODEX_CONCURRENCY: '16' }).concurrency, 8);
});

test('retry delays grow fourfold per attempt with up to half again of jitter either way', () => {
  for (let run = 0; run < 50; run++) {
    const first = jitteredDelay(5_000, 0);
    const second = jitteredDelay(5_000, 1);
    assert.ok(first >= 2_500 && first < 7_500, String(first));
    assert.ok(second >= 10_000 && second < 30_000, String(second));
  }
  assert.equal(jitteredDelay(0, 2), 0);
});

test('batch files carry the position and a fingerprint of the request', () => {
  const request = { provider: 'claude-code-v1', model: 'm', records: [{ itemIndex: 0 }] };
  assert.equal(batchFingerprint(request), sha256(JSON.stringify(request)).slice(0, 16));
  assert.notEqual(batchFingerprint(request), batchFingerprint({ ...request, model: 'n' }));
  assert.deepEqual(batchFiles('/work', 6, 'abc'), {
    result: join('/work', 'batch-0007-abc.json'),
    splitMarker: join('/work', 'split-0007-abc.json'),
  });
});

test('indexed results refuse a wrong count or a repeated index in the stage wording', () => {
  const wording = { wrongCount: 'wrong count', duplicate: 'duplicate' };
  const byIndex = indexedResults({ results: [{ itemIndex: 1, v: 'b' }, { itemIndex: 0, v: 'a' }] }, 2, wording);
  assert.deepEqual(byIndex.get(0), { itemIndex: 0, v: 'a' });
  assert.throws(() => indexedResults({ results: [{ itemIndex: 0 }] }, 2, wording), /^Error: wrong count$/);
  assert.throws(() => indexedResults({ results: 'none' }, 0, wording), /^Error: wrong count$/);
  assert.throws(() => indexedResults({ results: [{ itemIndex: 0 }, { itemIndex: 0 }] }, 2, wording), /^Error: duplicate$/);
});

test('a cached batch result is reused without asking the model', async t => {
  const dir = workDir(t);
  const resultPath = join(dir, 'batch-0001-x.json');
  writeFileSync(resultPath, JSON.stringify({ results: ['cached'] }));
  let asked = 0;
  const results = await runCachedModelBatch({
    resultPath,
    prompt: () => 'prompt',
    correction: () => '',
    ask: async () => { asked++; return {}; },
    validate: (parsed: { results: string[] }) => parsed.results,
    retryDelay: () => 0,
    lifecycle: lifecycle(),
  });
  assert.deepEqual(results, ['cached']);
  assert.equal(asked, 0);
});

test('an invalid answer is deleted and asked again with the reason, three times at most', async t => {
  const dir = workDir(t);
  const resultPath = join(dir, 'batch-0001-x.json');
  const prompts: string[] = [];
  const delays: number[] = [];
  await assert.rejects(runCachedModelBatch({
    resultPath,
    prompt: (correction: string) => `ask${correction}`,
    correction: (message: string) => ` [fix: ${message}]`,
    ask: async ({ prompt, resultPath: path }: { prompt: string; resultPath: string }) => {
      prompts.push(prompt);
      writeFileSync(path, JSON.stringify({ attempt: prompts.length }));
      return { attempt: prompts.length };
    },
    validate: (parsed: { attempt: number }) => { throw new Error(`bad answer ${parsed.attempt}`); },
    retryDelay: (attempt: number) => { delays.push(attempt); return 0; },
    lifecycle: lifecycle(),
  }), /bad answer 3/);
  assert.deepEqual(prompts, ['ask', 'ask [fix: bad answer 1]', 'ask [fix: bad answer 2]']);
  assert.deepEqual(delays, [0, 1]);
  // The last answer stays cached for inspection; the earlier ones were deleted before each retry.
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { attempt: 3 });
});

test('a stage that is aborting does not retry a failed batch', async t => {
  const dir = workDir(t);
  const stage = lifecycle();
  stage.aborting = true;
  let asked = 0;
  await assert.rejects(runCachedModelBatch({
    resultPath: join(dir, 'batch.json'),
    prompt: () => 'ask',
    correction: () => '',
    ask: async () => { asked++; throw new Error('killed'); },
    validate: () => [],
    retryDelay: () => 0,
    lifecycle: stage,
  }), /killed/);
  assert.equal(asked, 1);
});

test('a failing batch is halved down to the item that fails alone, and a later run resumes from the markers', async t => {
  const dir = workDir(t);
  const runs: string[][] = [];
  const splits: string[] = [];
  const options = {
    run: async (batch: string[]) => {
      runs.push(batch);
      if (batch.includes('poison')) throw new Error(`failed ${batch.join('+')}`);
      return batch.map(item => item.toUpperCase());
    },
    markerPath: (batch: string[]) => join(dir, `split-${batch.join('+')}.json`),
    marker: (batch: string[], error: string, depth: number) => ({ batch, error, depth }),
    onSplit: ({ batch, halves, depth, resumed }: { batch: string[]; halves: string[][]; depth: number; resumed: boolean }) => {
      splits.push(`${resumed ? 'resumed' : 'split'} ${batch.join('+')} -> ${halves.map(half => half.join('+')).join(' | ')} @${depth}`);
    },
    onSingletonFailure: (item: string, error: string) => ({ item, error }),
    lifecycle: lifecycle(),
  };

  const first = await runSplittingBatches(['a', 'b', 'poison', 'c', 'd'], options);
  assert.deepEqual(first, { results: ['A', 'B', 'C', 'D'], failures: [{ item: 'poison', error: 'failed poison' }] });
  assert.deepEqual(runs, [['a', 'b', 'poison', 'c', 'd'], ['a', 'b', 'poison'], ['a', 'b'], ['poison'], ['c', 'd']]);
  assert.deepEqual(splits, ['split a+b+poison+c+d -> a+b+poison | c+d @0', 'split a+b+poison -> a+b | poison @1']);
  assert.deepEqual(readdirSync(dir).sort(), ['split-a+b+poison+c+d.json', 'split-a+b+poison.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'split-a+b+poison.json'), 'utf8')), {
    batch: ['a', 'b', 'poison'], error: 'failed a+b+poison', depth: 1,
  });

  // The markers send the next run straight to the halves; a single item is always tried.
  runs.length = 0;
  splits.length = 0;
  const second = await runSplittingBatches(['a', 'b', 'poison', 'c', 'd'], options);
  assert.deepEqual(second, first);
  assert.deepEqual(runs, [['a', 'b'], ['poison'], ['c', 'd']]);
  assert.deepEqual(splits, ['resumed a+b+poison+c+d -> a+b+poison | c+d @0', 'resumed a+b+poison -> a+b | poison @1']);
});

test('a batch that fails while the stage is aborting is not split', async t => {
  const dir = workDir(t);
  const stage = lifecycle();
  stage.aborting = true;
  await assert.rejects(runSplittingBatches(['a', 'b'], {
    run: async () => { throw new Error('killed'); },
    markerPath: () => join(dir, 'split.json'),
    marker: () => ({}),
    onSplit: () => assert.fail('split while aborting'),
    onSingletonFailure: () => assert.fail('recorded a failure while aborting'),
    lifecycle: stage,
  }), /killed/);
  assert.equal(existsSync(join(dir, 'split.json')), false);
});

test('the pool keeps at most `concurrency` items in flight and visits each once', async () => {
  let inFlight = 0;
  let mostInFlight = 0;
  const visited: number[] = [];
  await runPool(7, 3, lifecycle(), async (index: number) => {
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    visited.push(index);
    inFlight--;
  });
  assert.equal(mostInFlight, 3);
  assert.deepEqual(visited.sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6]);
});

test('the first failure in the pool stops the stage and is rethrown', async () => {
  const stage = lifecycle();
  await assert.rejects(runPool(4, 2, stage, async (index: number) => {
    if (index === 1) throw new Error('batch 2 failed');
    await new Promise(resolve => setTimeout(resolve, 5));
  }), /batch 2 failed/);
  assert.equal(stage.terminated, 1);
  assert.equal(stage.aborting, true);
});
