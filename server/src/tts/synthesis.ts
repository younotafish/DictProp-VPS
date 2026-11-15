// Speech synthesis through DeepInfra's MiMo-V2.5-TTS (free): the clear track with a stock voice, the casual
// track with the voice-design model and a style description. Generated once and stored in the cache, so the
// neural model never runs in any browser.
//
// MiMo returns WAV (even when mp3 is requested), so we transcode to MP3 via ffmpeg for size +
// universal iOS playback. If ffmpeg is missing (e.g. local dev), we store the WAV unchanged —
// still playable, just larger — so nothing breaks without ffmpeg installed.
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import { ProcessError, runProcess } from './process.js';

const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';
const VOICEDESIGN_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts-voicedesign';
export const GEN_TIMEOUT_MS = 90_000;
// ffmpeg turns a sentence clip around in well under a second; a wedged process must not hold the
// request (or a backfill worker) forever.
const FFMPEG_TIMEOUT_MS = 60_000;
// The casual track's voice, described for the voice-design model.
const CASUAL_VOICE = (
  'Very casual, mumbled American woman, almost careless — slurs and runs words together, drops ' +
  'consonants and word-endings, talks fast and low under her breath, half-swallowing sounds like ' +
  'candid background dialogue in a naturalistic indie film. Deliberately unclear, reduced and lazy ' +
  '— NOT articulate, NOT crisp, NOT a voice actor.'
);

// Transcode WAV -> MP3 via ffmpeg. Falls back to the original bytes if ffmpeg is unavailable,
// errors or hangs, so the feature still works (just with larger files) where ffmpeg isn't installed.
export async function transcodeToMp3(wav: Buffer, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  try {
    const { stdout, stderr } = await runProcess(
      ffmpeg,
      ['-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1'],
      { input: wav, timeoutMs: FFMPEG_TIMEOUT_MS, captureStdout: true },
    );
    if (stdout.length) return stdout;
    console.warn('[tts] ffmpeg failed, storing WAV:', stderr.slice(0, 200));
  } catch (error) {
    const failure = error instanceof ProcessError ? error.reason : 'spawn';
    if (failure === 'timeout') console.warn(`[tts] ffmpeg exceeded ${FFMPEG_TIMEOUT_MS}ms, storing WAV`);
    else if (failure === 'exit') console.warn('[tts] ffmpeg failed, storing WAV:', (error as ProcessError).stderr.slice(0, 200));
    // 'spawn': ffmpeg is not installed, so the WAV is kept without a warning.
  }
  return wav;
}

// Call a MiMo model, decode the base64 data-URL, transcode to mp3. Returns the bytes to store. `label` names
// the model in errors. The time limit covers the whole exchange, the audio body included, not only the headers.
async function synthesize(url: string, label: string, text: string, voice: string): Promise<Buffer> {
  if (!env.DEEPINFRA_API_KEY) throw new Error('DEEPINFRA_API_KEY not configured');
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.DEEPINFRA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, output_format: 'wav' }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`${label} error ${res.status}: ${e.slice(0, 200)}`);
  }
  const data = await res.json() as { audio?: unknown } | null;
  let audio = typeof data?.audio === 'string' ? data.audio : '';
  if (!audio) throw new Error(`${label} returned no audio`);
  if (audio.startsWith('data:')) audio = audio.slice(audio.indexOf(',') + 1);
  const raw = Buffer.from(audio, 'base64');
  if (raw.length === 0) throw new Error(`${label} returned empty audio`);
  return transcodeToMp3(raw);
}

/** The clear track: a stock MiMo voice. */
export const synthClear = (text: string, voice: string): Promise<Buffer> => synthesize(MIMO_URL, 'MiMo', text, voice);

/** The casual track: the voice-design model speaking a respelled sentence in the casual style. */
export const synthCasual = (spoken: string): Promise<Buffer> => synthesize(VOICEDESIGN_URL, 'voicedesign', spoken, CASUAL_VOICE);
