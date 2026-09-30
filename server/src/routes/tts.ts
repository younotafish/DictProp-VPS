// Server-side TTS cache.
//
// Generates speech once via DeepInfra's MiMo-V2.5-TTS (free) and stores it on disk so every
// device fetches the cached clip instantly — the neural model never runs in any browser.
// Files live under DATA_DIR/tts/<key[:2]>/<key> (extension-less; content-type is sniffed on
// serve). Cache is GLOBAL — keyed by voice+text, shared across users — pronunciation isn't
// user-private. requireAuth (mounted on /api/*) still gates these endpoints.
//
// MiMo returns WAV (even when mp3 is requested), so we transcode to MP3 via ffmpeg for size +
// universal iOS playback. If ffmpeg is missing (e.g. local dev), we store the WAV unchanged —
// still playable, just larger — so nothing breaks without ffmpeg installed.

import { Hono } from 'hono';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { readFile, writeFile, access, rename, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import { getAllSentenceTexts } from '../db.js';
import { alignAudioLocally, type AlignmentPriority } from '../local-whisper.js';
import { getAllRealLifeCatalogSentenceTexts } from '../real-life-catalog.js';
import { getAllEssayCatalogSentenceTexts } from '../essay-catalog.js';
import type { WordTiming } from '../tts-alignment.js';

export const ttsRoutes = new Hono();

const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';
// Default English voice. Options: Mia, Chloe (female), Milo, Dean (male), mimo_default.
const MIMO_VOICE = 'Mia';
const OFFLINE_CACHE_VOICES = new Set([
  'qwen3-aiden-clear-v1',
  'qwen3-aiden-casual-v1',
]);
const TTS_DIR = resolve(env.DATA_DIR, 'tts');
const BACKFILL_STATUS_PATH = resolve(env.DATA_DIR, 'tts-backfill-status.json');
const GEN_TIMEOUT_MS = 90_000;
// ffmpeg turns a sentence clip around in well under a second; a wedged process must not hold the
// request (or a backfill worker) forever.
const FFMPEG_TIMEOUT_MS = 60_000;

// ── Casual "style" track ─────────────────────────────────────────────────────
// A second rendition of each sentence in fast, reduced, movie-like speech. The cache "voice" field
// doubles as a STYLE token: any MiMo voice name (e.g. 'Mia') = the clear track; the CASUAL_STYLE
// sentinel = the casual recipe below. The clip is keyed by (style, ORIGINAL sentence) — so the
// client finds it from the on-screen text — while the AUDIO is a phonetically-reduced respelling the
// AI produces (e.g. "reaching"->"reachin'", "to him"->"ta 'im"). Vocabulary words are preserved; only
// pronunciation changes. Both clear and casual clips receive locally generated word timings.
const CASUAL_STYLE = 'casual';
const VOICEDESIGN_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts-voicedesign';
const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const REDUCE_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const CASUAL_VOICE = (
  'Very casual, mumbled American woman, almost careless — slurs and runs words together, drops ' +
  'consonants and word-endings, talks fast and low under her breath, half-swallowing sounds like ' +
  'candid background dialogue in a naturalistic indie film. Deliberately unclear, reduced and lazy ' +
  '— NOT articulate, NOT crisp, NOT a voice actor.'
);
// Strict: respell for casual PRONUNCIATION only — never paraphrase, or the studied vocab is lost.
const REDUCE_SYS = (
  'Respell an English sentence to show how it is ACTUALLY pronounced in fast, casual, everyday/movie ' +
  'speech. This is for a vocabulary learner, so you MUST preserve every content word (nouns, verbs, ' +
  'adjectives, adverbs) EXACTLY as given — do NOT paraphrase, swap synonyms, delete/add words, or ' +
  'change the structure. ONLY allowed changes: contractions (cannot->can\'t, I am->I\'m); function-word ' +
  'reductions (going to->gonna, want to->wanna, got to->gotta, kind of->kinda, have to->hafta, for->fer, ' +
  'to->ta, them->\'em, him->\'im, and->an\', of->o\', because->\'cause); dropped -g (-ing -> -in\'); and ' +
  'optional "..." for a natural pause. Output ONLY the respelled line, nothing else.'
);

mkdirSync(TTS_DIR, { recursive: true });

// key = sha256(voice + "\n" + text.trim()) hex — MUST match the client (services/api.ts ttsKey).
function ttsKey(text: string, voice: string): string {
  return createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
}

function pathForKey(key: string): string {
  return join(TTS_DIR, key.slice(0, 2), key);
}

// Per-word timings live in a sibling JSON next to the (extension-less) audio file — no collision.
function timingsPathForKey(key: string): string {
  return pathForKey(key) + '.json';
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Write through a temp file + rename: clips are served as immutable for a year, so a crash mid-write
// must never leave a truncated file under the final name.
async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// Sniff audio content-type from the leading bytes (we store mp3 normally, wav as the no-ffmpeg fallback).
function sniffContentType(buf: Buffer): string {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'audio/mpeg';
}

// Transcode WAV -> MP3 via ffmpeg. Falls back to the original bytes if ffmpeg is unavailable,
// errors or hangs, so the feature still works (just with larger files) where ffmpeg isn't installed.
function transcodeToMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((res) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (b: Buffer) => { if (!settled) { settled = true; clearTimeout(timer); res(b); } };
    timer = setTimeout(() => {
      console.warn(`[tts] ffmpeg exceeded ${FFMPEG_TIMEOUT_MS}ms, storing WAV`);
      ff.kill('SIGKILL');
      done(wav);
    }, FFMPEG_TIMEOUT_MS);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', () => done(wav)); // ffmpeg not installed -> keep WAV
    ff.on('close', (code) => {
      if (settled) return;
      if (code === 0 && out.length) return done(Buffer.concat(out));
      console.warn('[tts] ffmpeg failed, storing WAV:', Buffer.concat(err).toString().slice(0, 200));
      done(wav);
    });
    ff.stdin.on('error', () => {}); // swallow EPIPE if ffmpeg died early
    try { ff.stdin.write(wav); ff.stdin.end(); } catch { /* error event handles it */ }
  });
}

// Call MiMo, decode the base64 data-URL, transcode to mp3. Returns the bytes to store.
async function synthMiMo(text: string, voice: string): Promise<Buffer> {
  if (!env.DEEPINFRA_API_KEY) throw new Error('DEEPINFRA_API_KEY not configured');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await proxyFetch(MIMO_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DEEPINFRA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, output_format: 'wav' }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`MiMo error ${res.status}: ${e.slice(0, 200)}`);
  }
  const data: any = await res.json();
  let audio: string = data?.audio || '';
  if (!audio) throw new Error('MiMo returned no audio');
  if (audio.startsWith('data:')) audio = audio.slice(audio.indexOf(',') + 1);
  const raw = Buffer.from(audio, 'base64');
  if (raw.length === 0) throw new Error('MiMo returned empty audio');
  return transcodeToMp3(raw);
}

async function postLargeJson(url: string, body: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
  try {
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    return response.ok ? await response.text() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function isCasual(voice: string): boolean {
  return voice === CASUAL_STYLE;
}

// A clip is "complete" when it has both audio and word timings (both styles now). Used by /generate
// and the backfill to skip finished clips (and to backfill timings onto legacy audio-only clips).
async function isComplete(key: string): Promise<boolean> {
  return (await fileExists(pathForKey(key))) && (await fileExists(timingsPathForKey(key)));
}

// Call the voice-design model (natural-language voice/style description) → mp3 bytes to store.
async function synthVoiceDesign(text: string, voiceDesc: string): Promise<Buffer> {
  if (!env.DEEPINFRA_API_KEY) throw new Error('DEEPINFRA_API_KEY not configured');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await proxyFetch(VOICEDESIGN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DEEPINFRA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceDesc, output_format: 'wav' }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`voicedesign error ${res.status}: ${e.slice(0, 200)}`);
  }
  const data: any = await res.json();
  let audio: string = data?.audio || '';
  if (!audio) throw new Error('voicedesign returned no audio');
  if (audio.startsWith('data:')) audio = audio.slice(audio.indexOf(',') + 1);
  const raw = Buffer.from(audio, 'base64');
  if (raw.length === 0) throw new Error('voicedesign returned empty audio');
  return transcodeToMp3(raw);
}

// The model sometimes wraps its line in quotes: strip one wrapping pair of double quotes (straight or
// curly). Apostrophes ARE the respelling ("'cause", "goin'") and must survive. Null when nothing is left.
export function cleanCasualRespelling(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const wrapped = /^["\u201c\u201d]([\s\S]*)["\u201c\u201d]$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  return text || null;
}

// Respell ONE sentence into its casual spoken form (vocabulary preserved). Null when the respelling
// failed: voicing the original spelling would store a clear clip under the casual key for good.
async function reduceToCasual(sentence: string): Promise<string | null> {
  const body = JSON.stringify({
    model: REDUCE_MODEL,
    messages: [{ role: 'system', content: REDUCE_SYS }, { role: 'user', content: sentence }],
    temperature: 0.3,
    // A respelling runs about as long as its sentence; 200 tokens cut off the longer essay sentences.
    max_tokens: 800,
  });
  const raw = await postLargeJson(CHAT_URL, body);
  if (!raw) return null;
  try {
    const choice: any = JSON.parse(raw)?.choices?.[0];
    // A line cut off at max_tokens would voice only part of the sentence.
    if (choice?.finish_reason === 'length') return null;
    return cleanCasualRespelling(choice?.message?.content);
  } catch {
    return null;
  }
}

// Respell MANY sentences in one chat call (batch throughput for the backfill). Returns reduced forms
// aligned 1:1 with the input (null where one failed); on any count mismatch / parse failure, falls back
// to per-sentence reduce.
async function reduceCasualBatch(sentences: string[]): Promise<Array<string | null>> {
  if (sentences.length <= 1) return sentences.length ? [await reduceToCasual(sentences[0])] : [];
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const sys = REDUCE_SYS + ' You will receive a numbered list; respond with JSON {"lines":[...]} ' +
    'containing one respelled line per input, in the SAME order and the SAME count.';
  const body = JSON.stringify({
    model: REDUCE_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
  });
  const raw = await postLargeJson(CHAT_URL, body);
  try {
    const data: any = JSON.parse(raw);
    let content: any = data?.choices?.[0]?.message?.content ?? '';
    if (typeof content === 'string') content = JSON.parse(content);
    const lines = Array.isArray(content?.lines) ? content.lines : null;
    if (lines && lines.length === sentences.length) {
      return lines.map((line: unknown) => cleanCasualRespelling(line));
    }
  } catch {
    /* fall through to per-sentence */
  }
  const out: Array<string | null> = [];
  for (const s of sentences) out.push(await reduceToCasual(s));
  return out;
}

// The network and whisper steps, swappable so tests can drive the routes without DeepInfra or whisper.
interface TtsDependencies {
  synthClear(text: string, voice: string): Promise<Buffer>;
  synthCasual(spoken: string): Promise<Buffer>;
  reduce(sentence: string): Promise<string | null>;
  align(audio: Buffer, priority: AlignmentPriority): Promise<WordTiming[]>;
}

let deps: TtsDependencies = {
  synthClear: synthMiMo,
  synthCasual: (spoken) => synthVoiceDesign(spoken, CASUAL_VOICE),
  reduce: reduceToCasual,
  align: (audio, priority) => alignAudioLocally(audio, { priority }),
};

/** Test hook: replace some of the network/whisper steps. Returns a function restoring the previous ones. */
export function setTtsDependenciesForTest(overrides: Partial<TtsDependencies>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => { deps = previous; };
}

// In-flight dedupe so concurrent requests for the same key generate (or align) only once.
const audioInFlight = new Map<string, Promise<Buffer | null>>();
const timingsInFlight = new Map<string, Promise<void>>();

// Synthesize + store a clip's audio unless it already exists. `voice` doubles as the style: the
// CASUAL_STYLE sentinel runs the casual recipe (AI-reduce the text, then voice-design TTS); any other
// value is a MiMo voice (clear track). `reduced` lets the backfill pass a pre-batched casual respelling.
// Resolves the new bytes, or null when the clip was already on disk.
function ensureAudio(text: string, voice: string, reduced?: string): Promise<Buffer | null> {
  const key = ttsKey(text, voice);
  const existing = audioInFlight.get(key);
  if (existing) return existing;
  const job = (async () => {
    if (OFFLINE_CACHE_VOICES.has(voice)) {
      throw new Error(`${voice} is populated only by the verified offline audio bridge`);
    }
    const p = pathForKey(key);
    if (await fileExists(p)) return null;
    let audio: Buffer;
    let spoken: string | null = null;
    if (isCasual(voice)) {
      spoken = reduced ?? (await deps.reduce(text));
      // Nothing is stored, so a later request or backfill pass retries the respelling.
      if (!spoken) throw new Error('casual respelling failed');
      audio = await deps.synthCasual(spoken);
    } else {
      audio = await deps.synthClear(text, voice);
    }
    mkdirSync(join(TTS_DIR, key.slice(0, 2)), { recursive: true });
    await writeFileAtomic(p, audio);
    // Persist the spoken respelling next to the clip (transparency / future display). Best-effort.
    if (spoken) await writeFileAtomic(p + '.txt', spoken).catch(() => {});
    return audio;
  })().finally(() => audioInFlight.delete(key));
  audioInFlight.set(key, job);
  return job;
}

// Align + store a clip's word timings unless they already exist. A clip whisper hears no words in
// stores [] so it counts as complete instead of being re-aligned by every sweep; a failed alignment
// stores nothing, so a later request retries it. `fresh` saves re-reading audio just synthesized.
function ensureTimings(key: string, priority: AlignmentPriority, fresh?: Buffer | null): Promise<void> {
  const existing = timingsInFlight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const tp = timingsPathForKey(key);
    if (await fileExists(tp)) return;
    const audio = fresh ?? (await readFile(pathForKey(key)));
    let words: WordTiming[];
    try {
      words = await deps.align(audio, priority);
    } catch (error: any) {
      console.warn('[tts] local whisper alignment failed:', error?.message);
      return;
    }
    await writeFileAtomic(tp, JSON.stringify(words));
  })().finally(() => timingsInFlight.delete(key));
  timingsInFlight.set(key, job);
  return job;
}

// Word timings for BOTH styles. The casual audio's reduced text keeps word order, so index-aligned
// seek lands close (start times stay correct even if whisper mishears a mumbled word). Covers fresh
// clips AND legacy audio-only clips (no audio regen).
async function generateAndVerify(text: string, voice: string, reduced?: string): Promise<void> {
  const key = ttsKey(text, voice);
  const fresh = await ensureAudio(text, voice, reduced);
  await ensureTimings(key, 'background', fresh);
  if (!(await isComplete(key))) {
    throw new Error('audio or local word timings are still incomplete');
  }
}

// ── Background backfill ─────────────────────────────────────────────────────
// Generates audio + word timings for EVERY saved sentence, server-side, detached from any request —
// so the client never has to stay open. Idempotent (generateAndVerify skips clips that already have
// both files) and resumable (a restart just re-scans and skips what's done). Low concurrency since the
// work is I/O-bound (DeepInfra + tiny file writes), so it doesn't starve normal request serving.
const stripMarkers = (t: string): string =>
  (t || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1').trim();

type BackfillStatus = { running: boolean; total: number; done: number; generated: number; failed: number; startedAt: number; finishedAt: number };
let backfill: BackfillStatus = { running: false, total: 0, done: 0, generated: 0, failed: 0, startedAt: 0, finishedAt: 0 };
export function getBackfillStatus(): BackfillStatus { return { ...backfill }; }

async function getDetachedBackfillStatus(): Promise<BackfillStatus | null> {
  try {
    const value = JSON.parse(await readFile(BACKFILL_STATUS_PATH, 'utf8'));
    const heartbeatAt = Number(value?.heartbeatAt);
    if (value?.running !== true || !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > 120_000) return null;
    return {
      running: true,
      total: Number(value.total) || 0,
      done: Number(value.done) || 0,
      generated: Number(value.generated) || 0,
      failed: Number(value.failed) || 0,
      startedAt: Number(value.startedAt) || 0,
      finishedAt: Number(value.finishedAt) || 0,
    };
  } catch {
    return null;
  }
}

const BACKFILL_CONCURRENCY = 2;
const BACKFILL_GENERATION_ATTEMPTS = 3;
const BACKFILL_RETRY_DELAY_MS = 1_000;

export async function retryBackfillOperation(
  operation: () => Promise<void>,
  attempts = BACKFILL_GENERATION_ATTEMPTS,
  delayMs = BACKFILL_RETRY_DELAY_MS,
): Promise<{ succeeded: boolean; attempts: number; error?: unknown }> {
  const boundedAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    try {
      await operation();
      return { succeeded: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts && delayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs * attempt));
      }
    }
  }
  return { succeeded: false, attempts: boundedAttempts, error: lastError };
}

export function partitionBackfillTexts(catalogInput: string[], libraryInput: string[]): {
  catalog: string[];
  library: string[];
} {
  const catalog = Array.from(new Set(catalogInput.map(stripMarkers).filter(Boolean)));
  const catalogSet = new Set(catalog);
  const library = Array.from(new Set(libraryInput.map(stripMarkers).filter(Boolean)))
    .filter(text => !catalogSet.has(text));
  return { catalog, library };
}

async function runBackfillGroup(texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  // ── Clear pass: per-item parallel (each item also runs a whisper alignment). ──
  let idx = 0;
  const clearWorker = async () => {
    while (idx < texts.length) {
      const text = texts[idx++];
      const key = ttsKey(text, MIMO_VOICE);
      if (!(await isComplete(key))) {
        const result = await retryBackfillOperation(() => generateAndVerify(text, MIMO_VOICE));
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill clear item failed after ${result.attempts} attempts:`, e?.message);
        }
      }
      backfill.done++;
    }
  };
  await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => clearWorker()));

  // ── Casual pass ──
  // Split work: clips MISSING audio need a (batched) reduce + voice-design synth; clips that already
  // have audio but lack timings (legacy casual clips) just need a whisper alignment — no reduce/synth.
  const needAudio: string[] = [];
  const needTimingsOnly: string[] = [];
  for (const text of texts) {
    const k = ttsKey(text, CASUAL_STYLE);
    if (await isComplete(k)) continue;
    if (await fileExists(pathForKey(k))) needTimingsOnly.push(text);
    else needAudio.push(text);
  }
  backfill.done += texts.length - needAudio.length - needTimingsOnly.length; // already-complete casual

  // Timings-only: cheap, parallel (generateAndVerify skips synth, just aligns + writes timings).
  {
    let t = 0;
    const timingsWorker = async () => {
      while (t < needTimingsOnly.length) {
        const text = needTimingsOnly[t++];
        const result = await retryBackfillOperation(() => generateAndVerify(text, CASUAL_STYLE));
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill casual timings failed after ${result.attempts} attempts:`, e?.message);
        }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => timingsWorker()));
  }

  // Missing-audio: batch-reduce the spoken text (cheap throughput), then synth + align each clip.
  const CHUNK = 20;
  for (let i = 0; i < needAudio.length; i += CHUNK) {
    const chunk = needAudio.slice(i, i + CHUNK);
    let reduced: Array<string | null>;
    try {
      reduced = await reduceCasualBatch(chunk);
    } catch (e: any) {
      console.warn('[tts] backfill reduce batch failed, respelling each clip separately:', e?.message);
      reduced = chunk.map(() => null); // a missing respelling is retried per clip, never voiced as-is
    }
    let j = 0;
    const casualWorker = async () => {
      while (j < chunk.length) {
        const k = j++;
        const result = await retryBackfillOperation(
          () => generateAndVerify(chunk[k], CASUAL_STYLE, reduced[k] ?? undefined),
        );
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill casual item failed after ${result.attempts} attempts:`, e?.message);
        }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => casualWorker()));
  }
}

export async function runBackfill(): Promise<void> {
  if (backfill.running) return;
  // Synchronous setup (runs before the first await, so a non-awaiting caller still sees `total`).
  let catalogTexts: string[];
  let libraryTexts: string[];
  try {
    ({ catalog: catalogTexts, library: libraryTexts } = partitionBackfillTexts(
      [...getAllRealLifeCatalogSentenceTexts(), ...getAllEssayCatalogSentenceTexts()],
      getAllSentenceTexts(),
    ));
  } catch (e: any) {
    console.warn('[tts] backfill: failed to read items:', e?.message);
    return;
  }
  const sentenceCount = catalogTexts.length + libraryTexts.length;
  // Two styles per sentence, each with audio and word timings.
  backfill = { running: true, total: sentenceCount * 2, done: 0, generated: 0, failed: 0, startedAt: Date.now(), finishedAt: 0 };
  console.log(`[tts] backfill: starting for ${sentenceCount} sentences × 2 styles`);

  // The catalog is finite and product-critical. Finish both styles there before scanning the much
  // larger saved-item library, otherwise a new collection's casual track can wait for days.
  await runBackfillGroup(catalogTexts);
  await runBackfillGroup(libraryTexts);

  backfill.running = false;
  backfill.finishedAt = Date.now();
  console.log(`[tts] backfill done: generated=${backfill.generated} skipped=${backfill.total - backfill.generated - backfill.failed} failed=${backfill.failed}`);
}

// POST /api/tts/backfill — start the background backfill (no-op if already running); returns status.
// GET  /api/tts/backfill — current progress. Registered BEFORE /tts/:name so "backfill" isn't read as a key.
ttsRoutes.post('/tts/backfill', async (c) => {
  const detached = await getDetachedBackfillStatus();
  if (detached) return c.json(detached);
  runBackfill().catch((e) => console.warn('[tts] backfill error:', e?.message));
  return c.json(getBackfillStatus());
});
ttsRoutes.get('/tts/backfill', async (c) => c.json((await getDetachedBackfillStatus()) ?? getBackfillStatus()));

// GET /api/tts/:name  (name = "<64-hex-key>.mp3") — serve the cached clip or 404. Never generates.
ttsRoutes.get('/tts/:name', async (c) => {
  const key = c.req.param('name').replace(/\.(mp3|wav)$/i, '');
  if (!/^[0-9a-f]{64}$/.test(key)) return c.json({ error: 'bad key' }, 400);
  let buf: Buffer;
  try {
    buf = await readFile(pathForKey(key));
  } catch {
    return c.json({ error: 'not cached' }, 404);
  }
  return c.body(buf, 200, {
    'Content-Type': sniffContentType(buf),
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

// GET /api/tts/:name/timings  (name = "<64-hex-key>") — serve the clip's word timings or 404.
ttsRoutes.get('/tts/:name/timings', async (c) => {
  const key = c.req.param('name').replace(/\.(mp3|wav|json)$/i, '');
  if (!/^[0-9a-f]{64}$/.test(key)) return c.json({ error: 'bad key' }, 400);
  let buf: Buffer;
  try {
    buf = await readFile(timingsPathForKey(key));
  } catch {
    return c.json({ error: 'not cached' }, 404);
  }
  return c.body(buf, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

// POST /api/tts/generate  { items: [{ text, voice? }] } -> { generated, skipped, failed }.
// Used by the live cache-miss trigger (fire-and-forget, usually 1 item) and the bulk sweep, which the
// client splits into requests of at most GENERATE_MAX_ITEMS. Responds once each clip's AUDIO is stored —
// it is playable then — and aligns word timings afterwards; a lone live clip's alignment jumps ahead of
// backfill work. A client that disconnects stops further items from starting.
export const GENERATE_MAX_ITEMS = 40;
// Covers every study sentence: essay-catalog sentences run to ~600 characters and examples to 1000.
export const GENERATE_MAX_TEXT_CHARS = 1000;
const GENERATE_CONCURRENCY = 3;
// Only the tracks the client plays. Any other name would mint a new MiMo cache entry per request.
const GENERATE_VOICES = new Set([MIMO_VOICE, CASUAL_STYLE]);

ttsRoutes.post('/tts/generate', async (c) => {
  // Read before any await: the node adapter only aborts a signal that was accessed.
  const signal = c.req.raw.signal;
  const body = await c.req.json().catch(() => ({}));
  const items: Array<{ text?: unknown; voice?: unknown }> = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return c.json({ error: 'no items' }, 400);
  if (items.length > GENERATE_MAX_ITEMS) {
    return c.json({ error: `at most ${GENERATE_MAX_ITEMS} items per request` }, 400);
  }
  const priority: AlignmentPriority = items.length === 1 ? 'interactive' : 'background';
  let generated = 0, skipped = 0, failed = 0;
  const generateOne = async (item: { text?: unknown; voice?: unknown }) => {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const voice = typeof item?.voice === 'string' && item.voice ? item.voice : MIMO_VOICE;
    if (!text || text.length > GENERATE_MAX_TEXT_CHARS) { failed++; return; }
    // Versioned Qwen clips are generated, aligned, and validated on Apple Silicon, then imported.
    // Never silently put MiMo bytes behind an immutable Qwen cache key.
    if (OFFLINE_CACHE_VOICES.has(voice)) { skipped++; return; }
    if (!GENERATE_VOICES.has(voice)) { failed++; return; }
    try {
      const key = ttsKey(text, voice);
      // Skip when both the clip and its local word timings are complete.
      if (await isComplete(key)) { skipped++; return; }
      const fresh = await ensureAudio(text, voice);
      void ensureTimings(key, priority, fresh)
        .catch((e: any) => console.warn('[tts] word timings failed:', e?.message));
      generated++;
    } catch (e: any) {
      console.warn('[tts] generate failed:', e?.message);
      failed++;
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await generateOne(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(GENERATE_CONCURRENCY, items.length) }, () => worker()));
  return c.json({ generated, skipped, failed });
});

// POST /api/tts/manifest  { keys: [...], audioOnly?: bool } -> { have: [...] }  (which keys are cached).
// audioOnly=true lets callers inventory clips independently. The default requires audio + timings,
// so ordinary sweeps also repair legacy audio-only cache entries.
ttsRoutes.post('/tts/manifest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  const audioOnly = body?.audioOnly === true;
  const have: string[] = [];
  for (const k of keys) {
    if (!/^[0-9a-f]{64}$/.test(k)) continue;
    if (!(await fileExists(pathForKey(k)))) continue;
    if (audioOnly || (await fileExists(timingsPathForKey(k)))) have.push(k);
  }
  return c.json({ have });
});
