#!/usr/bin/env node

// Finds what the bridge leaves behind when a run ends early. A publisher deletes its release once the
// import is verified or it gives up, but one that is killed outright leaves the release, encrypted
// archive and all, on the public repository. A wave whose publication failed is set aside as
// wave-N.failed for inspection, and a published wave keeps its archive, which nothing reads again: every
// run encrypts a fresh one.
//
//   bridge-leftovers.mjs releases [--now <iso>] [--max-age-hours <n>] < releases.json
//     Reads `gh api --paginate --slurp repos/<owner>/<repo>/releases` (or a single page) and prints each
//     publisher release idle longer than the limit as "<tag><TAB><idle hours>".
//   bridge-leftovers.mjs local [--dry-run] [--now <iso>] [--failed-max-age-days <n>] <wave-state-root>...
//     Removes failed waves idle longer than the limit and the archives of published waves; with
//     --dry-run it lists them and removes nothing.

import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HOUR_MS = 60 * 60 * 1_000;
// Each cycle's publishers give up after two hours and a manual publisher after four, deleting the
// release either way, so a release idle for six hours has no publisher left.
export const RELEASE_MAX_AGE_MS = 6 * HOUR_MS;
export const FAILED_WAVE_MAX_AGE_MS = 7 * 24 * HOUR_MS;

// Exactly the tags the dispatchers and the essay publisher create, so no other release is ever touched.
export const PUBLISHER_TAG_PATTERN = new RegExp(
  '^(?:(?:corpus-audit|example-analyses|sentence-grammar|example-enrichments|vocab-images|real-life-audio)' +
  '-wave-\\d{4,}|private-essays)-\\d{8}T\\d{6}Z$',
);
const WAVE_PATTERN = /^wave-\d{4,}$/;
const FAILED_WAVE_PATTERN = /^wave-\d{4,}\.failed(?:-\d{8}T\d{6}Z)?$/;

// GitHub dates a release by its tag's commit, which can be days older than the release itself, so a
// release was last active at its newest timestamp, its publication and asset uploads included.
export function releaseActivity(release) {
  const times = [
    release?.created_at,
    release?.published_at,
    ...(Array.isArray(release?.assets) ? release.assets : []).flatMap(asset => [asset?.created_at, asset?.updated_at]),
  ].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function selectStaleReleases(pages, { now = Date.now(), maxAgeMs = RELEASE_MAX_AGE_MS } = {}) {
  if (!Array.isArray(pages)) throw new Error('expected a JSON array of releases');
  const stale = [];
  for (const release of pages.flat()) {
    const tag = release?.tag_name;
    if (typeof tag !== 'string' || !PUBLISHER_TAG_PATTERN.test(tag)) continue;
    const activity = releaseActivity(release);
    if (activity !== null && now - activity > maxAgeMs) stale.push({ tag, idleMs: now - activity });
  }
  return stale;
}

function directoryNames(path) {
  try {
    // Dirent types come from the entries themselves, so a symlink is never taken for a directory.
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function newestChange(path) {
  const stat = lstatSync(path);
  let newest = stat.mtimeMs;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) newest = Math.max(newest, newestChange(join(path, name)));
  }
  return newest;
}

// The dispatchers test these markers with `[ -s ]`: present and not empty.
function marked(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// Waves sit directly in a state root, or one level down under the vocabulary and item-image stages'
// fingerprint directories. Nothing inside a wave other than its archives is touched.
export function selectLocalLeftovers(roots, { now = Date.now(), failedMaxAgeMs = FAILED_WAVE_MAX_AGE_MS } = {}) {
  // Keyed by path, since overlapping roots can reach the same wave twice.
  const leftovers = new Map();
  const visit = (directory, depth) => {
    for (const name of directoryNames(directory)) {
      const path = join(directory, name);
      if (FAILED_WAVE_PATTERN.test(name)) {
        const idleMs = now - newestChange(path);
        if (idleMs > failedMaxAgeMs) leftovers.set(path, { kind: 'failed wave', path, idleMs });
      } else if (WAVE_PATTERN.test(name)) {
        if (!marked(join(path, 'published')) && !marked(join(path, 'publisher', 'complete'))) continue;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.enc')) {
            const archive = join(path, entry.name);
            leftovers.set(archive, { kind: 'published archive', path: archive, bytes: lstatSync(archive).size });
          }
        }
      } else if (depth === 0) {
        visit(path, 1);
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return [...leftovers.values()];
}

function describe(leftover) {
  return leftover.kind === 'failed wave'
    ? `failed wave ${leftover.path} (idle ${(leftover.idleMs / (24 * HOUR_MS)).toFixed(1)} days)`
    : `published archive ${leftover.path} (${(leftover.bytes / 1e6).toFixed(1)} MB)`;
}

export function removeLeftovers(leftovers, { dryRun = false, log = line => { process.stdout.write(`${line}\n`); } } = {}) {
  for (const leftover of leftovers) {
    if (!dryRun) rmSync(leftover.path, { recursive: leftover.kind === 'failed wave', force: true });
    log(`${dryRun ? 'would remove' : 'removed'} ${describe(leftover)}`);
  }
  const waves = leftovers.filter(leftover => leftover.kind === 'failed wave').length;
  const archives = leftovers.filter(leftover => leftover.kind === 'published archive');
  const megabytes = archives.reduce((total, archive) => total + archive.bytes, 0) / 1e6;
  log(`${dryRun ? 'would remove' : 'removed'} ${waves} failed wave(s) and ${archives.length} published ` +
    `archive(s) (${megabytes.toFixed(1)} MB)`);
}

function parseNow(value) {
  if (value === undefined) return Date.now();
  const now = Date.parse(value);
  if (!Number.isFinite(now)) throw new Error(`--now is not a date: ${value}`);
  return now;
}

function parsePositive(value, name) {
  const number = Number(value);
  if (!(number > 0)) throw new Error(`${name} must be a positive number`);
  return number;
}

const USAGE = 'Usage: bridge-leftovers.mjs releases [--now <iso>] [--max-age-hours <n>] < releases.json\n' +
  '       bridge-leftovers.mjs local [--dry-run] [--now <iso>] [--failed-max-age-days <n>] <wave-state-root>...';

function main(argv) {
  const { positionals: [command, ...roots], values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      now: { type: 'string' },
      'max-age-hours': { type: 'string' },
      'failed-max-age-days': { type: 'string' },
    },
  });
  const now = parseNow(values.now);
  if (command === 'releases' && roots.length === 0) {
    const maxAgeMs = values['max-age-hours'] === undefined
      ? RELEASE_MAX_AGE_MS
      : parsePositive(values['max-age-hours'], '--max-age-hours') * HOUR_MS;
    for (const { tag, idleMs } of selectStaleReleases(JSON.parse(readFileSync(0, 'utf8')), { now, maxAgeMs })) {
      process.stdout.write(`${tag}\t${(idleMs / HOUR_MS).toFixed(1)}\n`);
    }
    return;
  }
  if (command === 'local' && roots.length > 0) {
    const failedMaxAgeMs = values['failed-max-age-days'] === undefined
      ? FAILED_WAVE_MAX_AGE_MS
      : parsePositive(values['failed-max-age-days'], '--failed-max-age-days') * 24 * HOUR_MS;
    removeLeftovers(selectLocalLeftovers(roots, { now, failedMaxAgeMs }), { dryRun: values['dry-run'] });
    return;
  }
  throw new Error(USAGE);
}

// Node runs the main module from its real path, so compare real paths when deciding to act as a CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
