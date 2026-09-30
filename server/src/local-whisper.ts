import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWhisperCppTimings, type WordTiming } from './tts-alignment.js';

const WHISPER_BIN = process.env.WHISPER_CPP_BIN || '/usr/local/bin/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_CPP_MODEL || '/opt/whisper/ggml-tiny.en.bin';
const ALIGNMENT_TIMEOUT_MS = 180_000;
const configuredThreads = Number.parseInt(process.env.WHISPER_CPP_THREADS || '2', 10);
const WHISPER_THREADS = Number.isFinite(configuredThreads)
  ? Math.max(1, Math.min(2, configuredThreads))
  : 2;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise();
    };
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on('error', error => finish(error));
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited with ${code ?? signal}: ${stderr.slice(-2_000)}`));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} exceeded ${ALIGNMENT_TIMEOUT_MS}ms`));
    }, ALIGNMENT_TIMEOUT_MS);
  });
}

async function alignOnce(audio: Buffer): Promise<WordTiming[]> {
  await Promise.all([access(WHISPER_BIN), access(WHISPER_MODEL)]);
  const root = await mkdtemp(join(tmpdir(), 'dictprop-whisper-'));
  try {
    const inputPath = join(root, 'audio.bin');
    const wavPath = join(root, 'audio.wav');
    const outputPrefix = join(root, 'alignment');
    await writeFile(inputPath, audio);
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
    ]);
    await run(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-l', 'en',
      '-t', String(WHISPER_THREADS),
      '-bo', '1',
      '-bs', '1',
      '-sow',
      '-ml', '1',
      '-ojf',
      '-of', outputPrefix,
      '-np',
      '-ng',
    ]);
    const parsed = JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8'));
    // No words is a real answer (a silent clip) and gets stored; output without a transcription is not.
    if (!Array.isArray(parsed?.transcription)) throw new Error('whisper output has no transcription');
    return parseWhisperCppTimings(parsed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export type AlignmentPriority = 'interactive' | 'background';

// Runs one task at a time; an interactive task (a clip someone is waiting on) is taken before any
// queued background work, so a live request never waits behind a backfill run.
export function createPriorityQueue() {
  const waiting: Record<AlignmentPriority, Array<() => void>> = { interactive: [], background: [] };
  let running = false;
  const next = () => {
    if (running) return;
    const start = waiting.interactive.shift() ?? waiting.background.shift();
    if (!start) return;
    running = true;
    start();
  };
  return function schedule<T>(task: () => Promise<T>, priority: AlignmentPriority = 'background'): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      waiting[priority].push(() => {
        Promise.resolve()
          .then(task)
          .then(resolvePromise, reject)
          .finally(() => { running = false; next(); });
      });
      next();
    });
  };
}

// A tiny model still uses a meaningful amount of memory. Serialize alignment so two backfill workers
// can synthesize concurrently without loading two model copies on the 2 GB VPS.
const alignmentQueue = createPriorityQueue();
export function alignAudioLocally(
  audio: Buffer,
  options: { priority?: AlignmentPriority } = {},
): Promise<WordTiming[]> {
  return alignmentQueue(() => alignOnce(audio), options.priority ?? 'background');
}
