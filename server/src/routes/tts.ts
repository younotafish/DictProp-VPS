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

export const ttsRoutes = new Hono();

const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';
// Default English voice. Options: Mia, Chloe (female), Milo, Dean (male), mimo_default.
const MIMO_VOICE = 'Mia';
// Word-level forced alignment: transcribe the synthesized clip back with word timestamps so the
// client can seek playback to any word. chunk_level:'word' is REQUIRED — without it `words` is empty.
const WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-timestamped-medium.en';
const TTS_DIR = resolve(env.DATA_DIR, 'tts');
const GEN_TIMEOUT_MS = 90_000;

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

// In-flight dedupe so concurrent requests for the same key generate only once.
const inFlight = new Map<string, Promise<void>>();

function generateAndStore(text: string, voice: string): Promise<void> {
  const key = ttsKey(text, voice);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const p = pathForKey(key);
    const tp = timingsPathForKey(key);
    let audioBuf: Buffer | null = null;
    if (!(await fileExists(p))) {
      audioBuf = await synthMiMo(text, voice);
      mkdirSync(join(TTS_DIR, key.slice(0, 2)), { recursive: true });
      await writeFile(p, audioBuf);
    }
    // Add word timings if missing — covers fresh clips AND legacy audio-only clips (no audio regen).
    if (!(await fileExists(tp))) {
      const buf = audioBuf ?? (await readFile(p));
      const words = await alignTimings(buf);
      if (words.length) await writeFile(tp, JSON.stringify(words));
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

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
      // Skip only when BOTH audio and timings exist — a legacy audio-only clip still needs timings.
      if (await fileExists(pathForKey(key)) && await fileExists(timingsPathForKey(key))) { skipped++; continue; }
      await generateAndStore(text, voice);
      generated++;
    } catch (e: any) {
      console.warn('[tts] generate failed:', e?.message);
      failed++;
    }
  }
  return c.json({ generated, skipped, failed });
});

// POST /api/tts/manifest  { keys: [...] } -> { have: [...] }  (which keys are already cached).
ttsRoutes.post('/tts/manifest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  const have: string[] = [];
  for (const k of keys) {
    // "have" = fully cached (audio + timings); a clip missing timings should be (re)generated so the
    // bulk sweep backfills word timings for legacy audio-only clips.
    if (/^[0-9a-f]{64}$/.test(k) && (await fileExists(pathForKey(k))) && (await fileExists(timingsPathForKey(k)))) have.push(k);
  }
  return c.json({ have });
});
