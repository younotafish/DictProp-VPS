import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../env.js';
import { validateOfflineTtsBundle, type OfflineTtsBundle } from '../offline-tts-import.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-offline-tts <manifest.json>');

const resolvedManifest = resolve(manifestPath);
const bundle = JSON.parse(readFileSync(resolvedManifest, 'utf8')) as OfflineTtsBundle;
const validationError = validateOfflineTtsBundle(bundle);
if (validationError) throw new Error(validationError);

const bundleRoot = dirname(resolvedManifest);
const ttsRoot = resolve(env.DATA_DIR, 'tts');
mkdirSync(ttsRoot, { recursive: true });

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const insideBundle = (relativePath: string): string => {
  const path = resolve(bundleRoot, relativePath);
  if (!path.startsWith(`${bundleRoot}${sep}`)) throw new Error('path escapes bundle root');
  return path;
};

type WordTiming = { start: number; end: number; text: string };
function parseTimings(bytes: Buffer, duration: number): WordTiming[] {
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) throw new Error('timings are empty or oversized');
  let previousEnd = 0;
  for (const timing of value) {
    if (!timing || typeof timing !== 'object' ||
        !Number.isFinite((timing as any).start) || !Number.isFinite((timing as any).end) ||
        (timing as any).start < 0 || (timing as any).end <= (timing as any).start ||
        (timing as any).start + 0.05 < previousEnd ||
        typeof (timing as any).text !== 'string' || !(timing as any).text.trim()) {
      throw new Error('timings are malformed or non-monotonic');
    }
    previousEnd = (timing as any).end;
  }
  if (previousEnd > duration + 0.75) throw new Error('timings exceed audio duration');
  return value as WordTiming[];
}

function probeDuration(path: string): number {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path,
  ], { encoding: 'utf8', timeout: 30_000 });
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

// A file lands whole or not at all: it is written and synced under a temp name in its own directory, then
// renamed over the final name. The temp name carries the pid, so concurrent imports never share one.
function installFile(target: string, bytes: Buffer): void {
  const temp = `${target}.${process.pid}.importing`;
  rmSync(`${target}.importing`, { force: true }); // left by an import from before the pid was in the name
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
    const audioPath = insideBundle(entry.audioFile);
    const timingsPath = insideBundle(entry.timingsFile);
    const audio = readFileSync(audioPath);
    const timings = readFileSync(timingsPath);
    if (audio.length < 1_000 || audio.length > 10 * 1024 * 1024) throw new Error('audio size is invalid');
    if (sha256(audio) !== entry.audioSha256) throw new Error('audio hash mismatch');
    if (sha256(timings) !== entry.timingsSha256) throw new Error('timings hash mismatch');
    const duration = probeDuration(audioPath);
    if (Math.abs(duration - entry.durationSeconds) > 0.25) throw new Error('audio duration mismatch');
    parseTimings(timings, duration);

    const targetDir = resolve(ttsRoot, entry.key.slice(0, 2));
    const targetAudio = resolve(targetDir, entry.key);
    const targetTimings = `${targetAudio}.json`;
    mkdirSync(targetDir, { recursive: true });

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
    result.errors.push({ key: entry.key, error: error instanceof Error ? error.message : String(error) });
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
