// What every model stage (vocabulary completion, sentence analysis, the image judge and the prompt
// refiner) does the same way: its settings, its lifecycle and worker pool, and the cached, retried and,
// where a stage allows it, split batch requests. Each stage script keeps what it asks the model and what
// it accepts as an answer.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-file.mjs';
import { installSignalCleanup, killProcessGroup } from './codex-process.mjs';
import { ModelCallError, checkModelReady } from './structured-model.mjs';

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

// The CODEX_* variables govern every provider; they are named for the first one. Concurrency comes from
// the first of concurrencyVariables that is set.
export function stageSettings(
  { defaultTimeoutMinutes, maxConcurrency = 16, concurrencyVariables = ['CODEX_CONCURRENCY'] },
  env = process.env,
) {
  const requestedTimeoutMinutes = Number(env.CODEX_TIMEOUT_MINUTES || defaultTimeoutMinutes);
  const timeoutMinutes = Number.isFinite(requestedTimeoutMinutes)
    ? Math.max(5, Math.min(60, requestedTimeoutMinutes))
    : defaultTimeoutMinutes;
  const requestedConcurrency = concurrencyVariables.map(name => env[name]).find(Boolean);
  return {
    timeoutMs: timeoutMinutes * 60 * 1_000,
    retryDelayMs: Math.max(0, Math.min(60_000, Number(env.CODEX_RETRY_DELAY_MS || 5_000))),
    concurrency: Math.max(1, Math.min(maxConcurrency, Number(requestedConcurrency || 4))),
  };
}

// Exponential and jittered, so parallel workers that failed together do not retry together.
export function jitteredDelay(retryDelayMs, attempt) {
  return retryDelayMs * 4 ** attempt * (0.5 + Math.random());
}

// Owns a stage's running model processes. A signal marks the stage as aborting, so no batch retries;
// terminate() does the same after a failed batch and stops whatever is still running.
export function createStageLifecycle() {
  const activeChildren = new Set();
  let aborting = false;
  installSignalCleanup(activeChildren, () => { aborting = true; });
  return {
    activeChildren,
    get aborting() {
      return aborting;
    },
    async terminate() {
      aborting = true;
      for (const child of activeChildren) killProcessGroup(child, 'SIGTERM');
      await sleep(2_000);
      for (const child of activeChildren) killProcessGroup(child, 'SIGKILL');
    },
  };
}

// Runs work(index) for every index below count, at most `concurrency` at a time. The first failure stops
// the stage's model processes and is rethrown.
export async function runPool(count, concurrency, lifecycle, work) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      await work(index);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  } catch (error) {
    await lifecycle.terminate();
    throw error;
  }
}

// A batch's result is cached, and a failed batch marked for splitting, under names that carry the batch's
// position and a fingerprint of everything that shaped its request: the provider and model, the
// instruction, the schema and the records. Editing a prompt therefore never reuses an answer to the old one.
export function batchFingerprint(config, { instruction, schema, records }) {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: config.cacheKey,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      instruction,
      schema,
      records,
    }))
    .digest('hex')
    .slice(0, 16);
}

export function batchFiles(workDir, batchIndex, fingerprint) {
  const position = String(batchIndex + 1).padStart(4, '0');
  return {
    result: join(workDir, `batch-${position}-${fingerprint}.json`),
    splitMarker: join(workDir, `split-${position}-${fingerprint}.json`),
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const CACHE_FILE_PATTERN = /^(?:batch|split)-\d{4}-[0-9a-f]{16}\.json$/;

// A stage whose work directory outlives the cycle (vocabulary completion, sentence analysis) clears cached
// results and split markers older than maxAgeMs when it starts. Their fingerprints change whenever a batch's
// cards do, so an old one is almost never read again; one that would have been is just asked for again.
export function pruneStageCache(workDir, { maxAgeMs = 14 * DAY_MS, now = Date.now() } = {}) {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(workDir)) {
    if (!CACHE_FILE_PATTERN.test(name)) continue;
    const path = join(workDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue;
    unlinkSync(path);
    files++;
    bytes += stat.size;
  }
  if (files > 0) {
    process.stderr.write(`Removed ${files} cached batch file(s) older than ${Math.round(maxAgeMs / DAY_MS)} days ` +
      `(${(bytes / 1e6).toFixed(1)} MB) from ${workDir}\n`);
  }
  return { files, bytes };
}

// The model answers a batch with one result per itemIndex. This maps them by index and refuses a wrong count
// or a repeated index, with the stage's own wording.
export function indexedResults(parsed, count, { wrongCount, duplicate }) {
  if (!Array.isArray(parsed.results) || parsed.results.length !== count) throw new Error(wrongCount);
  const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
  if (byIndex.size !== count) throw new Error(duplicate);
  return byIndex;
}

// Up to three attempts at one batch, with jittered backoff from retryDelayMs. A cached result is reused. An
// answer that fails validation is deleted, and the next attempt's prompt carries the reason so the model can
// correct it; a call that failed outright (a ModelCallError) is repeated as it was sent. A batch that can be
// split is split as soon as it times out, since its halves may fit the time; a single item gets one more try.
//   prompt(correction)  the full prompt, with the correction text ('' on the first attempt) in its place
//   correction(message) the correction text for a failure
//   ask(request)        sends { prompt, resultPath } to the model and resolves to the parsed result
//   validate(parsed)    returns the batch's results, or throws why the answer is unusable
export async function runCachedModelBatch({
  resultPath, prompt, correction, ask, validate, retryDelayMs, splittable = false, lifecycle,
}) {
  let correctionText = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const parsed = existsSync(resultPath)
        ? JSON.parse(readFileSync(resultPath, 'utf8'))
        : await ask({ prompt: prompt(correctionText), resultPath });
      return validate(parsed);
    } catch (error) {
      const failedCall = error instanceof ModelCallError ? error.kind : undefined;
      const outOfTime = failedCall === 'timeout' && (splittable || attempt > 0);
      if (lifecycle.aborting || attempt === 2 || outOfTime) throw error;
      if (!failedCall) correctionText = correction(errorMessage(error));
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await sleep(jitteredDelay(retryDelayMs, attempt));
    }
  }
}

// A batch that keeps failing is halved until the failure is pinned to single items, so one item the model
// cannot handle no longer takes its batch-mates down with it. Each split leaves a marker, so a later run
// goes straight to the halves, whose results are cached. Resolves to { results, failures }.
//   run(batch)                               the batch's results, or throws
//   markerPath(batch)                        where the batch's split marker lives
//   marker(batch, error, depth)              what the marker records
//   onSplit({ batch, halves, depth, error, resumed })  told of each split; resumed when a marker existed
//   onSingletonFailure(item, message, error) the failure recorded for an item that failed on its own; it may
//                                            throw instead, to fail the stage
export async function runSplittingBatches(batch, options, depth = 0) {
  const { run, markerPath, marker, onSplit, onSingletonFailure, lifecycle } = options;
  const splitMarkerPath = markerPath(batch);
  const midpoint = Math.ceil(batch.length / 2);
  const halves = [batch.slice(0, midpoint), batch.slice(midpoint)];
  if (batch.length === 1 || !existsSync(splitMarkerPath)) {
    try {
      return { results: await run(batch), failures: [] };
    } catch (error) {
      if (lifecycle.aborting) throw error;
      const message = errorMessage(error);
      if (batch.length === 1) return { results: [], failures: [await onSingletonFailure(batch[0], message, error)] };
      writeJsonAtomic(splitMarkerPath, marker(batch, message, depth));
      onSplit({ batch, halves, depth, error: message, resumed: false });
    }
  } else {
    onSplit({ batch, halves, depth, resumed: true });
  }
  const left = await runSplittingBatches(halves[0], options, depth + 1);
  const right = await runSplittingBatches(halves[1], options, depth + 1);
  return { results: [...left.results, ...right.results], failures: [...left.failures, ...right.failures] };
}

// A request that fails even for a single item is blamed on that item only while the model still answers its
// readiness check. Otherwise this rethrows the request's error: the stage fails, nothing is blamed, and the
// runner's own readiness check ends the cycle.
export async function rethrowIfModelDown(error, config, lifecycle) {
  try {
    await checkModelReady(config, { activeChildren: lifecycle.activeChildren });
  } catch (readinessError) {
    process.stderr.write(`${config.label} ${config.model} failed its readiness check as well: ${errorMessage(readinessError)}\n`);
    throw error;
  }
}
