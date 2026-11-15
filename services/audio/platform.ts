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

export const isMobile = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)); // iPadOS

/**
 * iOS / iPadOS — where in-browser Kokoro is impractical (no big download / slow WASM). These devices
 * use the system Web Speech voice as the cache-miss fallback and never download the Kokoro model.
 * Catches iPadOS Safari masquerading as Mac (platform 'MacIntel' + touch).
 */
export const isIOS = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
