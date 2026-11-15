// Speech synthesis through DeepInfra's MiMo-V2.5-TTS (free): the clear track with a stock voice, the casual
// track with the voice-design model and a style description. Generated once and stored in the cache, so the
// neural model never runs in any browser.
//
// MiMo returns WAV (even when mp3 is requested), so we transcode to MP3 via ffmpeg for size +
// universal iOS playback. If ffmpeg is missing (e.g. local dev), we store the WAV unchanged —
// still playable, just larger — so nothing breaks without ffmpeg installed.
import { spawn } from 'child_process';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';

const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';
const VOICEDESIGN_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts-voicedesign';
export const GEN_TIMEOUT_MS = 90_000;
// ffmpeg turns a sentence clip around in well under a second; a wedged process must not hold the
// request (or a backfill worker) forever.
const FFMPEG_TIMEOUT_MS = 60_000;
export const CASUAL_VOICE = (
  'Very casual, mumbled American woman, almost careless — slurs and runs words together, drops ' +
  'consonants and word-endings, talks fast and low under her breath, half-swallowing sounds like ' +
  'candid background dialogue in a naturalistic indie film. Deliberately unclear, reduced and lazy ' +
  '— NOT articulate, NOT crisp, NOT a voice actor.'
);

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
export async function synthMiMo(text: string, voice: string): Promise<Buffer> {
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

// Call the voice-design model (natural-language voice/style description) → mp3 bytes to store.
export async function synthVoiceDesign(text: string, voiceDesc: string): Promise<Buffer> {
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
