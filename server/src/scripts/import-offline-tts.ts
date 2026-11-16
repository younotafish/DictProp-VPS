import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { validateOfflineTtsBundle, type OfflineTtsBundle } from '../offline-tts-import.js';
import type { WordTiming } from '../tts-alignment.js';
import { audioPath, timingsPath } from '../tts/cache.js';
import { isProcessRunning } from '../tts/lock.js';
import { errorMessage, readBundleManifest, resolveInBundle } from './support/bundle.js';

const { bundle, bundleRoot } = readBundleManifest<OfflineTtsBundle>(
  'Usage: import-offline-tts <manifest.json>',
  validateOfflineTtsBundle,
);

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const insideBundle = (relativePath: string): string => {
  const path = resolveInBundle(bundleRoot, relativePath);
  if (!path) throw new Error('path escapes bundle root');
  return path;
};

function assertValidTimings(bytes: Buffer, duration: number): void {
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) throw new Error('timings are empty or oversized');
  let previousEnd = 0;
  for (const entry of value as unknown[]) {
    const timing = entry && typeof entry === 'object' ? entry as Partial<Record<keyof WordTiming, unknown>> : null;
    const { start, end, text } = timing ?? {};
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end <= start || start + 0.05 < previousEnd ||
        typeof text !== 'string' || !text.trim()) {
      throw new Error('timings are malformed or non-monotonic');
    }
    previousEnd = end;
  }
  if (previousEnd > duration + 0.75) throw new Error('timings exceed audio duration');
}

function probeDuration(path: string): number {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path,
  ], { encoding: 'utf8', timeout: 30_000 });
  // A missing or unrunnable ffprobe leaves no output to read.
  if (result.error) throw new Error(`ffprobe unavailable: ${result.error.message}`);
  const duration = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration)) throw new Error('ffprobe rejected audio');
  return duration;
}

function syncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Not every platform can sync a directory; the files themselves are already synced.
  }
}

// An import killed mid-write (a step timeout's SIGKILL) leaves its temp file behind. The next run that installs the
// same file removes it, unless the process that named it is still running.
function removeStaleTemps(target: string): void {
  const prefix = `${basename(target)}.`;
  for (const name of readdirSync(dirname(target))) {
    const pid = name.startsWith(prefix) ? /^(\d+)\.importing$/.exec(name.slice(prefix.length))?.[1] : undefined;
    if (pid === undefined || Number(pid) === process.pid || isProcessRunning(Number(pid))) continue;
    rmSync(join(dirname(target), name), { force: true });
  }
}

// A file lands whole or not at all: it is written and synced under a temp name in its own directory, then
// renamed over the final name. The temp name carries the pid, so concurrent imports never share one.
function installFile(target: string, bytes: Buffer): void {
  const temp = `${target}.${process.pid}.importing`;
  rmSync(`${target}.importing`, { force: true }); // left by an import from before the pid was in the name
  removeStaleTemps(target);
  try {
    const fd = openSync(temp, 'w');
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  syncDirectory(dirname(target));
}

// An existing file is either this entry's own bytes (an earlier run got that far) or a different clip.
function installedState(path: string, expectedSha256: string): 'missing' | 'same' | 'different' {
  if (!existsSync(path)) return 'missing';
  return sha256(readFileSync(path)) === expectedSha256 ? 'same' : 'different';
}

const result = { total: bundle.entries.length, imported: 0, skipped: 0, errors: [] as Array<{ key: string; error: string }> };

for (const entry of bundle.entries) {
  try {
    const audioPathInBundle = insideBundle(entry.audioFile);
    const timingsPathInBundle = insideBundle(entry.timingsFile);
    const audio = readFileSync(audioPathInBundle);
    const timings = readFileSync(timingsPathInBundle);
    if (audio.length < 1_000 || audio.length > 10 * 1024 * 1024) throw new Error('audio size is invalid');
    if (sha256(audio) !== entry.audioSha256) throw new Error('audio hash mismatch');
    if (sha256(timings) !== entry.timingsSha256) throw new Error('timings hash mismatch');
    const duration = probeDuration(audioPathInBundle);
    if (Math.abs(duration - entry.durationSeconds) > 0.25) throw new Error('audio duration mismatch');
    assertValidTimings(timings, duration);

    const targetAudio = audioPath(entry.key);
    const targetTimings = timingsPath(entry.key);
    mkdirSync(dirname(targetAudio), { recursive: true });

    const audioState = installedState(targetAudio, entry.audioSha256);
    const timingsState = installedState(targetTimings, entry.timingsSha256);
    if (audioState === 'different' || timingsState === 'different') {
      throw new Error('immutable cache key already contains different content; publish a new voice version');
    }
    if (audioState === 'same' && timingsState === 'same') { result.skipped++; continue; }

    // Timings go first. The server serves no clip without audio, but it aligns timings of its own for audio
    // that has none, so audio arriving first could race the import's timings. A re-run finishes either half.
    if (timingsState === 'missing') installFile(targetTimings, timings);
    if (audioState === 'missing') installFile(targetAudio, audio);
    result.imported++;
  } catch (error) {
    result.errors.push({ key: entry.key, error: errorMessage(error) });
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
