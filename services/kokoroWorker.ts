/**
 * The Kokoro voice (services/neuralTts.ts), run in a worker. Loading the ~326 MB model and synthesizing a
 * sentence each take seconds of CPU on the WASM backend, which on the page would freeze scrolling and taps
 * until they finished.
 *
 * One request at a time, since a model session runs one inference at once. A request that a newer one
 * replaced while it waited is dropped unheard: only the latest speech is ever played.
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
// The only runtime file the default onnxruntime-web build fetches (its JS glue is bundled into it).
import ortWasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

export type KokoroDevice = 'webgpu' | 'wasm';
/** Synthesize `text`, loading the model on the first of `devices` that works if it isn't loaded yet. */
export interface KokoroRequest { id: number; text: string; voice: string; devices: KokoroDevice[] }
export type KokoroResponse =
  | { type: 'ready'; device: KokoroDevice }
  | { type: 'loadFailed'; device: KokoroDevice; message: string }
  | { type: 'audio'; id: number; audio: Blob }
  | { type: 'error'; id: number; message: string }
  /** Every device failed to load: nothing this session will make Kokoro speak. */
  | { type: 'unavailable'; message: string };

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// fp32 on every device: it's the only precision that produces clean audio for this model. Hard-won,
// confirmed on real devices: q8 → "radio static"/garbled and fp16 → static on *every* backend (the
// int8/fp16 weights are lossy for Kokoro), not just on WebGPU. fp32 costs a ~326 MB download (vs ~86 MB
// for q8) and is CPU-bound on WASM, but a correct slow voice beats a fast broken one.
const DTYPE = 'fp32';

// Skip the local /models/* lookup (404s): load straight from the HF Hub and the browser cache.
env.allowLocalModels = false;
// transformers.js points the WASM runtime at cdn.jsdelivr.net, which the page's CSP blocks. Load it from
// our own origin instead: a file (not a URL prefix) keeps the glue bundled, and the hashed /assets/ copy is
// cached by the service worker like the other optional voice files.
env.backends.onnx.wasm!.wasmPaths = { wasm: ortWasmUrl };

// The project type-checks against the DOM library, which types `self` as a window.
const scope = self as unknown as Worker;
const post = (message: KokoroResponse) => scope.postMessage(message);

let model: Promise<KokoroTTS> | null = null;

// Each device is tried once: a failed ~326 MB fetch isn't cached, so retrying at once would download it
// again. A failure clears the model, so the next request starts clean.
const loadModel = (devices: KokoroDevice[]): Promise<KokoroTTS> => {
  model ??= (async () => {
    let lastError: unknown = new Error('No Kokoro device to try');
    for (const device of devices) {
      try {
        const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device });
        post({ type: 'ready', device });
        return tts;
      } catch (error) {
        lastError = error;
        post({ type: 'loadFailed', device, message: String(error) });
      }
    }
    post({ type: 'unavailable', message: String(lastError) });
    throw lastError;
  })();
  model.catch(() => { model = null; });
  return model;
};

let latestId = 0;
let queue: Promise<void> = Promise.resolve();

const synthesize = async ({ id, text, voice, devices }: KokoroRequest): Promise<void> => {
  if (id !== latestId) {
    post({ type: 'error', id, message: 'superseded' });
    return;
  }
  try {
    const tts = await loadModel(devices);
    const audio = await tts.generate(text, { voice: voice as any });
    post({ type: 'audio', id, audio: audio.toBlob() });
  } catch (error) {
    post({ type: 'error', id, message: String(error) });
  }
};

scope.onmessage = ({ data }: MessageEvent<KokoroRequest>) => {
  latestId = Math.max(latestId, data.id);
  queue = queue.then(() => synthesize(data));
};
