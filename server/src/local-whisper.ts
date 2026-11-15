// Word timings for a clip from whisper.cpp, run locally on the server. Alignments run one at a time, live clips
// ahead of backfill work.
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWhisperCppTimings, type WordTiming } from './tts-alignment.js';
import { runProcess } from './tts/process.js';

const ALIGNMENT_TIMEOUT_MS = 180_000;
// Decoding a sentence clip takes well under a second; a wedged ffmpeg must not hold the alignment queue for long.
const DECODE_TIMEOUT_MS = 60_000;

// whisper.cpp's binary, model and thread count; the defaults are the Docker image's. Read when an alignment runs,
// after env.ts has loaded .env. At most 2 threads: the VPS has 2 vCPUs, shared with the web server and ffmpeg,
// and alignment is background work.
function whisperSettings(): { bin: string; model: string; threads: number } {
  const configuredThreads = Number.parseInt(process.env.WHISPER_CPP_THREADS || '2', 10);
  return {
    bin: process.env.WHISPER_CPP_BIN || '/usr/local/bin/whisper-cli',
    model: process.env.WHISPER_CPP_MODEL || '/opt/whisper/ggml-tiny.en.bin',
    threads: Number.isFinite(configuredThreads) ? Math.max(1, Math.min(2, configuredThreads)) : 2,
  };
}

async function alignOnce(audio: Buffer): Promise<WordTiming[]> {
  const whisper = whisperSettings();
  await Promise.all([access(whisper.bin), access(whisper.model)]);
  const root = await mkdtemp(join(tmpdir(), 'dictprop-whisper-'));
  try {
    const inputPath = join(root, 'audio.bin');
    const wavPath = join(root, 'audio.wav');
    const outputPrefix = join(root, 'alignment');
    await writeFile(inputPath, audio);
    await runProcess('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
    ], { timeoutMs: DECODE_TIMEOUT_MS });
    await runProcess(whisper.bin, [
      '-m', whisper.model,
      '-f', wavPath,
      '-l', 'en',
      '-t', String(whisper.threads),
      '-bo', '1',
      '-bs', '1',
      '-sow',
      '-ml', '1',
      '-ojf',
      '-of', outputPrefix,
      '-np',
      '-ng',
    ], { timeoutMs: ALIGNMENT_TIMEOUT_MS });
    const parsed = JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8'));
    // No words is a real answer (a silent clip) and gets stored; output without a transcription is not.
    if (!Array.isArray(parsed?.transcription)) throw new Error('whisper output has no transcription');
    return parseWhisperCppTimings(parsed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export type AlignmentPriority = 'interactive' | 'background';

export interface PriorityQueue {
  /** Queues a task; `key` names it for promote. */
  <T>(task: () => Promise<T>, priority?: AlignmentPriority, key?: string): Promise<T>;
  /** Moves a waiting background task ahead of the other background work: someone is waiting on it now. */
  promote(key: string): void;
}

// Runs one task at a time; an interactive task (a clip someone is waiting on) is taken before any
// queued background work, so a live request never waits behind a backfill run.
export function createPriorityQueue(): PriorityQueue {
  const waiting: Record<AlignmentPriority, Array<{ key?: string; start: () => void }>> = { interactive: [], background: [] };
  let running = false;
  const next = () => {
    if (running) return;
    const entry = waiting.interactive.shift() ?? waiting.background.shift();
    if (!entry) return;
    running = true;
    entry.start();
  };
  const schedule = <T>(task: () => Promise<T>, priority: AlignmentPriority = 'background', key?: string): Promise<T> =>
    new Promise<T>((resolvePromise, reject) => {
      waiting[priority].push({
        key,
        start: () => {
          Promise.resolve()
            .then(task)
            .then(resolvePromise, reject)
            .finally(() => { running = false; next(); });
        },
      });
      next();
    });
  const promote = (key: string): void => {
    const index = waiting.background.findIndex(entry => entry.key === key);
    if (index >= 0) waiting.interactive.push(...waiting.background.splice(index, 1));
  };
  return Object.assign(schedule, { promote });
}

// A tiny model still uses a meaningful amount of memory. Serialize alignment so two backfill workers
// can synthesize concurrently without loading two model copies on the 2 GB VPS.
const alignmentQueue = createPriorityQueue();
export function alignAudioLocally(
  audio: Buffer,
  options: { priority?: AlignmentPriority; key?: string } = {},
): Promise<WordTiming[]> {
  return alignmentQueue(() => alignOnce(audio), options.priority ?? 'background', options.key);
}

/** Moves the queued alignment of the clip `key` ahead of background work, if it is waiting. */
export function promoteAlignment(key: string): void {
  alignmentQueue.promote(key);
}
