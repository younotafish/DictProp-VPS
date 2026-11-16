import { detectPlatform } from '../platform';

// ---------------------------------------------------------------------------
// Capability gate
// ---------------------------------------------------------------------------
/** navigator.userAgentData only exists on Chromium — our proxy for "WebGPU is reliable here". */
const isChromium = (): boolean =>
  typeof navigator !== 'undefined' && !!(navigator as Navigator & { userAgentData?: unknown }).userAgentData;

/**
 * WebGPU is only reliable through onnxruntime-web on Chromium. Safari exposes navigator.gpu
 * (iOS/iPadOS/macOS 26+) but its WebGPU breaks our ONNX runtime, so we keep Apple on WASM.
 */
export const canUseWebGPU = (): boolean =>
  typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu && isChromium();

/**
 * True when the device can run Kokoro at all. WASM runs anywhere with WebAssembly (every modern
 * browser, including iOS/iPadOS Safari), so neural is broadly supported — it uses the GPU when it
 * can and the CPU otherwise.
 */
export const isNeuralSupported = (): boolean =>
  typeof navigator !== 'undefined' && typeof WebAssembly !== 'undefined';

// The device, from the app's one detector, asked on each call as these checks always were rather than read once like
// PLATFORM. The pointer doesn't matter to either question.
const device = () => detectPlatform(typeof navigator === 'undefined' ? undefined : navigator, () => false);

/** A phone or tablet: iPhone, iPad (iPadOS Safari reports 'MacIntel' with touch points) or Android. */
export const isMobile = (): boolean => device().isMobile;

/**
 * iOS / iPadOS — where in-browser Kokoro is impractical (no big download / slow WASM). These devices
 * use the system Web Speech voice as the cache-miss fallback and never download the Kokoro model.
 * Catches iPadOS Safari masquerading as Mac (platform 'MacIntel' + touch).
 */
export const isIOS = (): boolean => device().isIOS;
