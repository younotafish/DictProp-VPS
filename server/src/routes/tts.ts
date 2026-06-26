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
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { readFile, writeFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import { getAllSentenceTexts } from '../db.js';

export const ttsRoutes = new Hono();

const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';
// Default English voice. Options: Mia, Chloe (female), Milo, Dean (male), mimo_default.
const MIMO_VOICE = 'Mia';
// Word-level forced alignment: transcribe the synthesized clip back with word timestamps so the
// client can seek playback to any word. chunk_level:'word' is REQUIRED — without it `words` is empty.
const WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-timestamped-medium.en';
const TTS_DIR = resolve(env.DATA_DIR, 'tts');
const GEN_TIMEOUT_MS = 90_000;

// ── Casual "style" track ─────────────────────────────────────────────────────
// A second rendition of each sentence in fast, reduced, movie-like speech. The cache "voice" field
// doubles as a STYLE token: any MiMo voice name (e.g. 'Mia') = the clear track; the CASUAL_STYLE
// sentinel = the casual recipe below. The clip is keyed by (style, ORIGINAL sentence) — so the
// client finds it from the on-screen text — while the AUDIO is a phonetically-reduced respelling the
// AI produces (e.g. "reaching"->"reachin'", "to him"->"ta 'im"). Vocabulary words are preserved; only
// pronunciation changes. Casual clips have NO word timings (tap-to-seek stays on the clear track).
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

// Sniff audio content-type from the leading bytes (we store mp3 normally, wav as the no-ffmpeg fallback).
function sniffContentType(buf: Buffer): string {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'audio/mpeg';
}

// Transcode WAV -> MP3 via ffmpeg. Falls back to the original bytes if ffmpeg is unavailable
// or errors, so the feature still works (just with larger files) where ffmpeg isn't installed.
function transcodeToMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((res) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (b: Buffer) => { if (!settled) { settled = true; res(b); } };
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', () => done(wav)); // ffmpeg not installed -> keep WAV
    ff.on('close', (code) => {
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

// Forced word-alignment: transcribe a synthesized clip back to word-level timestamps via whisper
// (chunk_level:'word' is REQUIRED — without it `words` comes back empty). Best-effort: returns [] on any
// failure, so the audio still caches and the feature degrades to whole-sentence playback. A mis-heard
// word's text may be wrong, but its start time is still correct (the client aligns by sequence).
type WordTiming = { start: number; end: number; text: string };

// POST a JSON body via curl — undici's ProxyAgent stalls on a large request body behind the corporate
// proxy, whereas curl handles it (and goes direct on the VPS, where there's no proxy). curl honors the
// HTTPS_PROXY env automatically. Returns the response text, or '' on any failure. (Matches the existing
// pattern of shelling out to ffmpeg.)
function curlPostJson(url: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    const args = [
      '-s', '--max-time', String(Math.floor(GEN_TIMEOUT_MS / 1000)),
      '-X', 'POST',
      '-H', `Authorization: Bearer ${env.DEEPINFRA_API_KEY}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', '@-', url,
    ];
    const cp = spawn('curl', args);
    const out: Buffer[] = [];
    let settled = false;
    const done = (s: string) => { if (!settled) { settled = true; resolve(s); } };
    cp.stdout.on('data', (d) => out.push(d));
    cp.on('error', () => done('')); // curl not installed
    cp.on('close', (code) => done(code === 0 ? Buffer.concat(out).toString('utf8') : ''));
    cp.stdin.on('error', () => {});
    try { cp.stdin.write(body); cp.stdin.end(); } catch { /* error event handles it */ }
  });
}

async function alignTimings(audio: Buffer): Promise<WordTiming[]> {
  if (!env.DEEPINFRA_API_KEY) return [];
  const dataUrl = `data:${sniffContentType(audio)};base64,` + audio.toString('base64');
  const raw = await curlPostJson(WHISPER_URL, JSON.stringify({ audio: dataUrl, chunk_level: 'word', language: 'en' }));
  if (!raw) return [];
  try {
    const data: any = JSON.parse(raw);
    const words: any[] = Array.isArray(data?.words) ? data.words : [];
    return words
      .map((w) => ({ start: Number(w?.start) || 0, end: Number(w?.end) || 0, text: String(w?.word || '').trim() }))
      .filter((w) => w.text);
  } catch {
    return [];
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

// Respell ONE sentence into its casual spoken form (vocabulary preserved). Falls back to the original.
async function reduceToCasual(sentence: string): Promise<string> {
  const body = JSON.stringify({
    model: REDUCE_MODEL,
    messages: [{ role: 'system', content: REDUCE_SYS }, { role: 'user', content: sentence }],
    temperature: 0.3,
    max_tokens: 200,
  });
  const raw = await curlPostJson(CHAT_URL, body);
  if (!raw) return sentence;
  try {
    const data: any = JSON.parse(raw);
    const out = String(data?.choices?.[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '');
    return out || sentence;
  } catch {
    return sentence;
  }
}

// Respell MANY sentences in one chat call (batch throughput for the backfill). Returns reduced forms
// aligned 1:1 with the input; on any count mismatch / parse failure, falls back to per-sentence reduce.
async function reduceCasualBatch(sentences: string[]): Promise<string[]> {
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
  const raw = await curlPostJson(CHAT_URL, body);
  try {
    const data: any = JSON.parse(raw);
    let content: any = data?.choices?.[0]?.message?.content ?? '';
    if (typeof content === 'string') content = JSON.parse(content);
    const lines = Array.isArray(content?.lines) ? content.lines : null;
    if (lines && lines.length === sentences.length) {
      return lines.map((l: any, i: number) => String(l || '').trim() || sentences[i]);
    }
  } catch {
    /* fall through to per-sentence */
  }
  const out: string[] = [];
  for (const s of sentences) out.push(await reduceToCasual(s));
  return out;
}

// In-flight dedupe so concurrent requests for the same key generate only once.
const inFlight = new Map<string, Promise<void>>();

// Generate + store a clip. `voice` doubles as the style: the CASUAL_STYLE sentinel runs the casual
// recipe (AI-reduce the text, then voice-design TTS); any other value is a MiMo voice (clear track).
// BOTH styles get word timings now, so tap-to-seek works on the casual track too. `reduced` lets the
// backfill pass a pre-batched casual respelling.
function generateAndStore(text: string, voice: string, reduced?: string): Promise<void> {
  const key = ttsKey(text, voice);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const p = pathForKey(key);
    const tp = timingsPathForKey(key);
    let audioBuf: Buffer | null = null;
    if (!(await fileExists(p))) {
      if (isCasual(voice)) {
        const spoken = reduced ?? (await reduceToCasual(text));
        audioBuf = await synthVoiceDesign(spoken, CASUAL_VOICE);
        mkdirSync(join(TTS_DIR, key.slice(0, 2)), { recursive: true });
        await writeFile(p, audioBuf);
        // Persist the spoken respelling next to the clip (transparency / future display). Best-effort.
        await writeFile(p + '.txt', spoken).catch(() => {});
      } else {
        audioBuf = await synthMiMo(text, voice);
        mkdirSync(join(TTS_DIR, key.slice(0, 2)), { recursive: true });
        await writeFile(p, audioBuf);
      }
    }
    // Word timings for BOTH styles. The casual audio's reduced text keeps word order, so index-aligned
    // seek lands close (start times stay correct even if whisper mishears a mumbled word). Covers fresh
    // clips AND legacy audio-only clips (no audio regen).
    if (!(await fileExists(tp))) {
      const buf = audioBuf ?? (await readFile(p));
      const words = await alignTimings(buf);
      if (words.length) await writeFile(tp, JSON.stringify(words));
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

// ── Background backfill ─────────────────────────────────────────────────────
// Generates audio + word timings for EVERY saved sentence, server-side, detached from any request —
// so the client never has to stay open. Idempotent (generateAndStore skips clips that already have
// both files) and resumable (a restart just re-scans and skips what's done). Low concurrency since the
// work is I/O-bound (DeepInfra + tiny file writes), so it doesn't starve normal request serving.
const stripMarkers = (t: string): string =>
  (t || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1').trim();

type BackfillStatus = { running: boolean; total: number; done: number; generated: number; failed: number; startedAt: number; finishedAt: number };
let backfill: BackfillStatus = { running: false, total: 0, done: 0, generated: 0, failed: 0, startedAt: 0, finishedAt: 0 };
export function getBackfillStatus(): BackfillStatus { return { ...backfill }; }

const BACKFILL_CONCURRENCY = 2;
export async function runBackfill(): Promise<void> {
  if (backfill.running) return;
  // Synchronous setup (runs before the first await, so a non-awaiting caller still sees `total`).
  let texts: string[];
  try {
    texts = Array.from(new Set(getAllSentenceTexts().map(stripMarkers).filter(Boolean)));
  } catch (e: any) {
    console.warn('[tts] backfill: failed to read items:', e?.message);
    return;
  }
  // Two styles per sentence — clear (audio + word timings) and casual (audio only).
  backfill = { running: true, total: texts.length * 2, done: 0, generated: 0, failed: 0, startedAt: Date.now(), finishedAt: 0 };
  console.log(`[tts] backfill: starting for ${texts.length} sentences × 2 styles`);

  // ── Clear pass: per-item parallel (each item also runs a whisper alignment). ──
  let idx = 0;
  const clearWorker = async () => {
    while (idx < texts.length) {
      const text = texts[idx++];
      try {
        const key = ttsKey(text, MIMO_VOICE);
        if (!(await isComplete(key))) {
          await generateAndStore(text, MIMO_VOICE);
          backfill.generated++;
        }
      } catch (e: any) {
        backfill.failed++;
        console.warn('[tts] backfill clear item failed:', e?.message);
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

  // Timings-only: cheap, parallel (generateAndStore skips synth, just aligns + writes timings).
  {
    let t = 0;
    const timingsWorker = async () => {
      while (t < needTimingsOnly.length) {
        const text = needTimingsOnly[t++];
        try { await generateAndStore(text, CASUAL_STYLE); backfill.generated++; }
        catch (e: any) { backfill.failed++; console.warn('[tts] backfill casual timings failed:', e?.message); }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => timingsWorker()));
  }

  // Missing-audio: batch-reduce the spoken text (cheap throughput), then synth + align each clip.
  const CHUNK = 20;
  for (let i = 0; i < needAudio.length; i += CHUNK) {
    const chunk = needAudio.slice(i, i + CHUNK);
    let reduced: string[];
    try {
      reduced = await reduceCasualBatch(chunk);
    } catch (e: any) {
      console.warn('[tts] backfill reduce batch failed, using originals:', e?.message);
      reduced = chunk; // degrade to the casual VOICE over the original spelling
    }
    let j = 0;
    const casualWorker = async () => {
      while (j < chunk.length) {
        const k = j++;
        try {
          await generateAndStore(chunk[k], CASUAL_STYLE, reduced[k]);
          backfill.generated++;
        } catch (e: any) {
          backfill.failed++;
          console.warn('[tts] backfill casual item failed:', e?.message);
        }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => casualWorker()));
  }

  backfill.running = false;
  backfill.finishedAt = Date.now();
  console.log(`[tts] backfill done: generated=${backfill.generated} skipped=${backfill.total - backfill.generated - backfill.failed} failed=${backfill.failed}`);
}

// POST /api/tts/backfill — start the background backfill (no-op if already running); returns status.
// GET  /api/tts/backfill — current progress. Registered BEFORE /tts/:name so "backfill" isn't read as a key.
ttsRoutes.post('/tts/backfill', (c) => {
  runBackfill().catch((e) => console.warn('[tts] backfill error:', e?.message));
  return c.json(getBackfillStatus());
});
ttsRoutes.get('/tts/backfill', (c) => c.json(getBackfillStatus()));

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
// Used by the live cache-miss trigger (fire-and-forget, usually 1 item) and the bulk sweep.
ttsRoutes.post('/tts/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const items: Array<{ text?: string; voice?: string }> = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return c.json({ error: 'no items' }, 400);
  let generated = 0, skipped = 0, failed = 0;
  for (const it of items) {
    const text = (it?.text || '').trim();
    if (!text) { failed++; continue; }
    const voice = it.voice || MIMO_VOICE;
    try {
      const key = ttsKey(text, voice);
      // Skip when the clip is complete for its style (clear: audio+timings; casual: audio only).
      if (await isComplete(key)) { skipped++; continue; }
      await generateAndStore(text, voice);
      generated++;
    } catch (e: any) {
      console.warn('[tts] generate failed:', e?.message);
      failed++;
    }
  }
  return c.json({ generated, skipped, failed });
});

// POST /api/tts/manifest  { keys: [...], audioOnly?: bool } -> { have: [...] }  (which keys are cached).
// audioOnly=true (casual sweeps) treats a key as cached once its audio exists — casual clips have no
// timings. Default (clear) requires audio + timings so the sweep backfills timings for legacy clips.
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
