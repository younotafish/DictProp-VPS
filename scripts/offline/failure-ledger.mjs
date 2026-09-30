#!/usr/bin/env node

// Items that keep failing a stage are recorded here, keyed by id and a hash of their source content,
// and skipped until their backoff expires or their content changes. Without this, one item the model
// cannot handle fails its stage on every six-hour cycle and holds back everything behind it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_VERSION = 1;
// A stage exits with this when it made no progress at all, so the runner can re-check the model
// instead of treating the stage like a crash.
export const NOTHING_SUCCEEDED_EXIT_CODE = 3;

const HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 7 * 24 * HOUR_MS;
const PRUNE_AFTER_MS = 30 * 24 * HOUR_MS;

// The first three waits are shorter than the six-hour cycle, so an item caught by a transient outage
// is retried on the next cycle. An item that keeps failing settles at one attempt a week.
export function backoffMs(failures) {
  const count = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(MAX_BACKOFF_MS, HOUR_MS * 2 ** Math.min(count - 1, 20));
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: 0, stages: {} };
}

export function readLedger(path) {
  if (!path || !existsSync(path)) return emptyLedger();
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if (ledger?.version !== LEDGER_VERSION || !ledger.stages || typeof ledger.stages !== 'object' ||
        Array.isArray(ledger.stages)) {
      throw new Error('unsupported ledger format');
    }
    return ledger;
  } catch (error) {
    // A damaged ledger only costs a retry of known failures; it must never stop a cycle.
    process.stderr.write(`Ignoring unreadable failure ledger ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return emptyLedger();
  }
}

export function writeLedger(path, ledger, now = Date.now()) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ ...ledger, version: LEDGER_VERSION, updatedAt: now }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

export function prune(ledger, now = Date.now()) {
  for (const [stage, entries] of Object.entries(ledger.stages)) {
    if (!entries || typeof entries !== 'object') {
      delete ledger.stages[stage];
      continue;
    }
    for (const [id, entry] of Object.entries(entries)) {
      // An item that left the source stops being retried, so its entry would otherwise live forever.
      const abandoned = Number(entry?.lastFailedAt) < now - PRUNE_AFTER_MS && Number(entry?.retryAfter) <= now;
      if (!entry || typeof entry !== 'object' || abandoned) delete entries[id];
    }
    if (Object.keys(entries).length === 0) delete ledger.stages[stage];
  }
  return ledger;
}

export function isDeferred(entry, hash, now = Date.now()) {
  return Boolean(entry) && entry.hash === hash && Number(entry.retryAfter) > now;
}

export function recordFailure(ledger, stage, id, hash, error, now = Date.now()) {
  const entries = ledger.stages[stage] ||= {};
  const previous = entries[id];
  // Changed content is a new item as far as the model is concerned, so its count starts over.
  const repeated = previous?.hash === hash;
  const failures = repeated ? Math.max(0, Number(previous.failures) || 0) + 1 : 1;
  entries[id] = {
    hash,
    failures,
    firstFailedAt: repeated ? Number(previous.firstFailedAt) || now : now,
    lastFailedAt: now,
    retryAfter: now + backoffMs(failures),
    error: String(error ?? '').slice(0, 500),
  };
  return entries[id];
}

export function recordSuccess(ledger, stage, id) {
  const entries = ledger.stages[stage];
  if (!entries) return;
  delete entries[id];
  if (Object.keys(entries).length === 0) delete ledger.stages[stage];
}

export function updateLedger(path, mutate, now = Date.now()) {
  const ledger = prune(readLedger(path), now);
  mutate(ledger);
  writeLedger(path, ledger, now);
  return ledger;
}

function withoutImageFields(value) {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImageFields(child)]));
}

export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(withoutImageFields(value) ?? null)).digest('hex');
}

// The corpus export's sourceHash ignores review state and generated analyses, so a review does not
// look like an edit; older sources without it fall back to the item data.
export function parentHash(entry) {
  return typeof entry?.sourceHash === 'string' && entry.sourceHash ? entry.sourceHash : contentHash(entry?.data);
}

export function sentenceHash(sentence) {
  return typeof sentence?.textHash === 'string' && sentence.textHash ? sentence.textHash : contentHash(sentence);
}

export function imageTargetHash(target) {
  return createHash('sha256')
    .update(JSON.stringify([String(target?.prompt ?? '').trim(), target?.learningTarget ?? null]))
    .digest('hex');
}

// Stage scripts stay strict unless the runner hands them a ledger, so other pipelines that call them
// still fail on the first unfinished item.
export function ledgerFromEnvironment(defaultStage, env = process.env) {
  const path = String(env.ENRICHMENT_FAILURE_LEDGER || '').trim();
  if (!path) return null;
  const stage = String(env.ENRICHMENT_FAILURE_STAGE || defaultStage || '').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage)) throw new Error(`Invalid failure ledger stage: ${stage}`);
  return { path: resolve(path), stage };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJsonAtomic(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, target);
}

function filterList(ledgerPath, stage, items, keyOf, hashOf, label, now) {
  const entries = readLedger(ledgerPath).stages[stage] || {};
  const remaining = [];
  let deferred = 0;
  for (const item of items) {
    if (isDeferred(entries[keyOf(item)], hashOf(item), now)) deferred++;
    else remaining.push(item);
  }
  if (deferred > 0) {
    process.stderr.write(`Skipping ${deferred} ${label} in failure backoff (${stage}); see ${ledgerPath}\n`);
  }
  return remaining;
}

function fileReady(path) {
  return existsSync(path) && statSync(path).size > 0;
}

function formatEpoch(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : 'unknown';
}

function main(argv) {
  const [command, ...args] = argv;
  const now = Date.now();
  if (command === 'filter-sentences') {
    const [ledgerPath, stage, sourcePath, outputPath] = args;
    if (!ledgerPath || !stage || !sourcePath || !outputPath) {
      throw new Error('Usage: failure-ledger.mjs filter-sentences <ledger> <stage> <source.json> <output.json>');
    }
    const source = readJson(sourcePath);
    if (source?.version !== 1 || !Array.isArray(source.sentences)) throw new Error('Sentence source is invalid');
    // Every other field, including exportedAt, is kept: the dispatchers compare it with manifest ages.
    const sentences = filterList(ledgerPath, stage, source.sentences, sentence => sentence.id, sentenceHash,
      'sentence(s)', now);
    writeJsonAtomic(outputPath, { ...source, sentences });
    process.stdout.write(`${sentences.length}\n`);
    return;
  }
  if (command === 'filter-image-targets') {
    const [ledgerPath, stage, targetsPath, outputPath] = args;
    if (!ledgerPath || !stage || !targetsPath || !outputPath) {
      throw new Error('Usage: failure-ledger.mjs filter-image-targets <ledger> <stage> <targets.json> <output.json>');
    }
    const payload = readJson(targetsPath);
    if (!Array.isArray(payload?.targets)) throw new Error('Image target manifest is invalid');
    const targets = filterList(ledgerPath, stage, payload.targets, target => target.imageId, imageTargetHash,
      'image(s)', now);
    writeJsonAtomic(outputPath, { ...payload, targets });
    process.stdout.write(`${targets.length}\n`);
    return;
  }
  if (command === 'record-image-outcomes') {
    const [ledgerPath, stage, targetsPath, imagesDir, loopStatusArg] = args;
    if (!ledgerPath || !stage || !targetsPath || !imagesDir || loopStatusArg === undefined) {
      throw new Error('Usage: failure-ledger.mjs record-image-outcomes <ledger> <stage> <targets.json> <images-dir> <loop-status>');
    }
    const payload = readJson(targetsPath);
    if (!Array.isArray(payload?.targets)) throw new Error('Image target manifest is invalid');
    // Only a loop that finished can say an image was deferred; after a crash or timeout a missing
    // image may simply not have had its turn yet.
    const loopFinished = Number(loopStatusArg) === 0;
    let accepted = 0;
    let deferred = 0;
    updateLedger(ledgerPath, ledger => {
      for (const target of payload.targets) {
        if (fileReady(join(resolve(imagesDir), target.filename))) {
          recordSuccess(ledger, stage, target.imageId);
          accepted++;
        } else if (loopFinished) {
          recordFailure(ledger, stage, target.imageId, imageTargetHash(target),
            'no candidate passed image quality review', now);
          deferred++;
        }
      }
    }, now);
    process.stderr.write(`Recorded ${stage} image outcomes: accepted=${accepted}, deferred=${deferred}\n`);
    return;
  }
  if (command === 'summary') {
    const [ledgerPath] = args;
    if (!ledgerPath) throw new Error('Usage: failure-ledger.mjs summary <ledger>');
    const ledger = prune(readLedger(ledgerPath), now);
    for (const [stage, entries] of Object.entries(ledger.stages).sort(([left], [right]) => left.localeCompare(right))) {
      const values = Object.values(entries);
      const waiting = values.filter(entry => Number(entry.retryAfter) > now);
      const nextRetry = waiting.reduce((soonest, entry) => Math.min(soonest, Number(entry.retryAfter)), Infinity);
      const mostFailures = values.reduce((most, entry) => Math.max(most, Number(entry.failures) || 0), 0);
      process.stdout.write(
        `${stage}: ${values.length} failing item(s), ${waiting.length} in backoff` +
        `${waiting.length ? ` (next retry ${formatEpoch(nextRetry)})` : ''}, most failures ${mostFailures}\n`,
      );
    }
    return;
  }
  throw new Error(
    'Usage: failure-ledger.mjs <filter-sentences|filter-image-targets|record-image-outcomes|summary> ...',
  );
}

// Node runs the main module from its real path, so compare real paths when deciding to act as a CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
