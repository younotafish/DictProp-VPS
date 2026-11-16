import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  batchFiles,
  batchFingerprint,
  indexedResults,
  jitteredDelay,
  pruneStageCache,
  runCachedModelBatch,
  runPool,
  runSplittingBatches,
  stageSettings,
} from '../../scripts/offline/model-stage.mjs';
import { ModelCallError } from '../../scripts/offline/structured-model.mjs';
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

test('batch files carry the position and a fingerprint of everything that shaped the request', () => {
  const config = { cacheKey: 'claude-code-v1', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' };
  const request = { instruction: 'Do the thing.', schema: { type: 'object' }, records: [{ itemIndex: 0 }] };
  assert.equal(batchFingerprint(config, request), sha256(JSON.stringify({
    provider: 'claude-code-v1', model: 'claude-opus-5-5', reasoningEffort: 'xhigh', ...request,
  })).slice(0, 16));
  const others = [
    batchFingerprint({ ...config, cacheKey: 'codex-cli-v2' }, request),
    batchFingerprint({ ...config, model: 'other' }, request),
    batchFingerprint({ ...config, reasoningEffort: 'max' }, request),
    batchFingerprint(config, { ...request, instruction: 'Do the thing well.' }),
    batchFingerprint(config, { ...request, schema: { type: 'array' } }),
    batchFingerprint(config, { ...request, records: [{ itemIndex: 1 }] }),
  ];
  assert.equal(new Set([batchFingerprint(config, request), ...others]).size, 7);
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
    retryDelayMs: 0,
    lifecycle: lifecycle(),
  });
  assert.deepEqual(results, ['cached']);
  assert.equal(asked, 0);
});

test('an invalid answer is deleted and asked again with the reason, three times at most', async t => {
  const dir = workDir(t);
  const resultPath = join(dir, 'batch-0001-x.json');
  const prompts: string[] = [];
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
    retryDelayMs: 0,
    lifecycle: lifecycle(),
  }), /bad answer 3/);
  assert.deepEqual(prompts, ['ask', 'ask [fix: bad answer 1]', 'ask [fix: bad answer 2]']);
  // The last answer stays cached for inspection; the earlier ones were deleted before each retry.
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { attempt: 3 });
});

test('a call that failed outright is repeated as it was sent, without a validation correction', async t => {
  const dir = workDir(t);
  const prompts: string[] = [];
  const results = await runCachedModelBatch({
    resultPath: join(dir, 'batch.json'),
    prompt: (correction: string) => `ask${correction}`,
    correction: (message: string) => ` [fix: ${message}]`,
    ask: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { valid: false };
      if (prompts.length === 2) throw new ModelCallError('exit', 'Claude exited with 1: API Error: 529 overloaded');
      return { valid: true };
    },
    validate: (parsed: { valid: boolean }) => {
      if (!parsed.valid) throw new Error('missing field');
      return ['done'];
    },
    retryDelayMs: 0,
    splittable: true,
    lifecycle: lifecycle(),
  });
  assert.deepEqual(results, ['done']);
  // The overload neither replaced the earlier correction nor became one.
  assert.deepEqual(prompts, ['ask', 'ask [fix: missing field]', 'ask [fix: missing field]']);
});

test('a batch that times out is handed back for splitting at once, and a single item gets one more try', async t => {
  const dir = workDir(t);
  const attempts = async (splittable: boolean) => {
    let asked = 0;
    await assert.rejects(runCachedModelBatch({
      resultPath: join(dir, `batch-${splittable}.json`),
      prompt: () => 'ask',
      correction: () => '',
      ask: async () => { asked++; throw new ModelCallError('timeout', 'Claude did not answer within 40 min'); },
      validate: () => [],
      retryDelayMs: 0,
      splittable,
      lifecycle: lifecycle(),
    }), /did not answer within 40 min/);
    return asked;
  };
  assert.equal(await attempts(true), 1);
  assert.equal(await attempts(false), 2);
});

test('a single item whose first timeout follows another failure still gets its third attempt', async t => {
  const dir = workDir(t);
  // What the model does at each attempt: answer invalidly, fail outright, time out, or answer.
  const run = async (name: string, steps: Array<'invalid' | 'exit' | 'timeout' | 'ok'>) => {
    const prompts: string[] = [];
    const result = await runCachedModelBatch({
      resultPath: join(dir, `${name}.json`),
      prompt: (correction: string) => `ask${correction}`,
      correction: (message: string) => ` [fix: ${message}]`,
      ask: async ({ prompt }: { prompt: string }) => {
        const step = steps[prompts.push(prompt) - 1];
        if (step === 'exit') throw new ModelCallError('exit', 'Claude exited with 1: API Error: 529 overloaded');
        if (step === 'timeout') throw new ModelCallError('timeout', 'Claude did not answer within 40 min');
        return { valid: step === 'ok' };
      },
      validate: (parsed: { valid: boolean }) => {
        if (!parsed.valid) throw new Error('missing field');
        return ['done'];
      },
      retryDelayMs: 0,
      splittable: false,
      lifecycle: lifecycle(),
    }).catch((error: Error) => error.message);
    return { result, prompts };
  };
  // The timeout keeps the correction the invalid answer earned.
  assert.deepEqual(await run('invalid-timeout-ok', ['invalid', 'timeout', 'ok']), {
    result: ['done'],
    prompts: ['ask', 'ask [fix: missing field]', 'ask [fix: missing field]'],
  });
  assert.deepEqual(await run('exit-timeout-ok', ['exit', 'timeout', 'ok']), { result: ['done'], prompts: ['ask', 'ask', 'ask'] });
  assert.deepEqual(await run('timeout-timeout', ['timeout', 'timeout', 'ok']), {
    result: 'Claude did not answer within 40 min',
    prompts: ['ask', 'ask'],
  });
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
    retryDelayMs: 0,
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

test('cached batch results and split markers older than two weeks are cleared, and nothing else', t => {
  const dir = workDir(t);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1_000;
  const file = (name: string, ageDays: number, contents = 'x'.repeat(1_000)) => {
    writeFileSync(join(dir, name), contents);
    const time = new Date(now - ageDays * DAY);
    utimesSync(join(dir, name), time, time);
  };
  file('batch-0001-0123456789abcdef.json', 15);
  file('split-0002-0123456789abcdef.json', 30, 'x'.repeat(500));
  file('batch-0003-0123456789abcdef.json', 13);
  file('failures.json', 40);
  file('progress.json', 40);
  file('batch-0004-0123456789abcdef.json.123.cafebabe.tmp', 40);
  mkdirSync(join(dir, 'batch-0005-0123456789abcdef.json'));
  const outside = join(dir, 'outside.json');
  file('outside.json', 40);
  symlinkSync(outside, join(dir, 'batch-0006-0123456789abcdef.json'));

  assert.deepEqual(pruneStageCache(dir, { now }), { files: 2, bytes: 1_500 });
  assert.deepEqual(readdirSync(dir).sort(), [
    'batch-0003-0123456789abcdef.json',
    'batch-0004-0123456789abcdef.json.123.cafebabe.tmp',
    'batch-0005-0123456789abcdef.json',
    'batch-0006-0123456789abcdef.json',
    'failures.json',
    'outside.json',
    'progress.json',
  ]);
  assert.deepEqual(pruneStageCache(dir, { now, maxAgeMs: 12 * DAY }), { files: 1, bytes: 1_000 });
});
