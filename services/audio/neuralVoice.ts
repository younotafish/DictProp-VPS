/**
 * The in-browser Kokoro voice, the desktop cache-miss fallback: consent, the worker client and its URL cache.
 * (Named for what it is rather than "kokoro…": the build marks chunks starting with "kokoro" as optional
 * downloads, and this module ships with the engine.)
 */
import type { KokoroDevice, KokoroRequest, KokoroResponse, KokoroVoice } from '../kokoroWorker';
import { log, warn } from '../logger';
import { canUseWebGPU, isMobile, isNeuralSupported } from './platform';
import { playUrl } from './player';
import { MAX_KOKORO_URLS, UrlLru } from './urlLru';

const DEFAULT_VOICE: KokoroVoice = 'af_heart'; // Kokoro fallback voice — American female (matches our GA/rhotic IPA)

const CONSENT_KEY = 'tts_neural_consent'; // mobile one-time download consent

// Whether the worker has the model loaded, so speech can use it without starting a download.
let modelReady = false;
const isModelReady = (): boolean => modelReady;
// Set once the model failed to load on every device (or the worker died before it loaded). For the rest of
// the session, cache misses go straight to the system voice instead of waiting on a load that just failed.
let kokoroUnavailable = false;

/** Devices to try, best-first. WebGPU-capable devices fall back to WASM if WebGPU load fails. */
const pickDevices = (): KokoroDevice[] => (canUseWebGPU() ? ['webgpu', 'wasm'] : ['wasm']);

const hasConsent = (): boolean => {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
};

/** On mobile, confirm the one-time ~330 MB (fp32) download before pulling it (respect cellular data). */
const confirmDownloadIfNeeded = (): boolean => {
  if (!isMobile() || hasConsent()) return true;
  const ok =
    typeof window !== 'undefined' &&
    window.confirm(
      'Download the natural voice? About 330 MB, one-time. After that it works offline with no further data.',
    );
  if (ok) {
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  return !!ok;
};

// ---------------------------------------------------------------------------
// Model + synthesis, in the worker
// ---------------------------------------------------------------------------
let worker: Worker | null = null;
let nextRequestId = 0;
const pendingClips = new Map<number, { resolve: (audio: Blob) => void; reject: (error: Error) => void }>();

// A clip that hasn't arrived by then is read by the system voice instead. Loading allows for the first
// ~326 MB download, which carries on in the worker so a later tap can use it; a loaded model makes a
// sentence in seconds, even on the CPU.
const KOKORO_LOAD_TIMEOUT_MS = 120_000;
const KOKORO_SYNTH_TIMEOUT_MS = 30_000;

/** Terminate a worker that can't make speech and fail whatever still waits on it. */
const dropWorker = (dropped: Worker, reason: string): void => {
  dropped.terminate();
  if (worker === dropped) worker = null;
  modelReady = false;
  for (const { reject } of pendingClips.values()) reject(new Error(reason));
};

const getWorker = (): Worker => {
  if (worker) return worker;
  const created = new Worker(new URL('../kokoroWorker.ts', import.meta.url), { type: 'module' });
  created.onmessage = ({ data }: MessageEvent<KokoroResponse>) => {
    if (data.type === 'ready') {
      modelReady = true;
      log(`🔊 Neural TTS: Kokoro model ready (fp32, ${data.device})`);
    } else if (data.type === 'loadFailed') {
      warn(`🔊 Neural TTS: ${data.device} load failed`, data.message);
    } else if (data.type === 'unavailable') {
      kokoroUnavailable = true;
      warn('🔊 Neural TTS: Kokoro unavailable this session, using the system voice', data.message);
      dropWorker(created, data.message);
    } else if (data.type === 'audio') {
      pendingClips.get(data.id)?.resolve(data.audio);
    } else {
      pendingClips.get(data.id)?.reject(new Error(data.message));
    }
  };
  // The worker's code couldn't load or crashed: drop it. Before the model loaded that's a failed load like
  // any other; after, the next play starts a fresh worker.
  created.onerror = event => {
    event.preventDefault();
    warn('🔊 Neural TTS: worker failed', event.message);
    if (!modelReady) kokoroUnavailable = true;
    dropWorker(created, event.message || 'Kokoro worker failed');
  };
  worker = created;
  return created;
};

const kokoroUrls = new UrlLru(MAX_KOKORO_URLS); // `${voice}:${text}` -> object URL

const synthesize = async (text: string, voice: KokoroVoice): Promise<string> => {
  const key = `${voice}:${text}`;
  const cached = kokoroUrls.get(key);
  if (cached) return cached;
  if (kokoroUnavailable) throw new Error('Kokoro is unavailable this session');
  const request: KokoroRequest = { id: ++nextRequestId, text, voice, devices: pickDevices() };
  const timeoutMs = modelReady ? KOKORO_SYNTH_TIMEOUT_MS : KOKORO_LOAD_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const audio = await new Promise<Blob>((resolve, reject) => {
    pendingClips.set(request.id, { resolve, reject });
    getWorker().postMessage(request);
    timer = setTimeout(() => reject(new Error(`Kokoro gave no audio within ${timeoutMs / 1000}s`)), timeoutMs);
  }).finally(() => {
    clearTimeout(timer);
    pendingClips.delete(request.id);
  });
  const url = URL.createObjectURL(audio);
  kokoroUrls.set(key, url);
  return url;
};

// macOS / desktop cache-miss fallback: synthesize in-browser with Kokoro, then play. Falls back to
// the system voice if the model can't load / consent is declined. iOS/iPadOS never reaches here.
export const speakViaKokoro = async (
  plain: string,
  opts: { onStart?: () => void; onEnd?: () => void; allowDownload: boolean },
  isCurrent: () => boolean,
  systemFallback: () => void,
): Promise<void> => {
  const { onStart, onEnd, allowDownload } = opts;
  const wouldDownload = !isModelReady();
  let useNeural = !kokoroUnavailable && isNeuralSupported() && (isModelReady() || allowDownload);
  if (useNeural && wouldDownload && allowDownload && !confirmDownloadIfNeeded()) useNeural = false;
  if (!useNeural) { systemFallback(); return; }
  try {
    const url = await synthesize(plain, DEFAULT_VOICE);
    if (!isCurrent()) return;
    await playUrl(url, isCurrent, onStart, onEnd);
  } catch (err) {
    if (!isCurrent()) return;
    warn('🔊 Kokoro failed, falling back to system voice', err);
    systemFallback();
  }
};
