// Silent keep-alive: holds the audio session — and with it the background gap timers — open during the
// (up to several-second) pauses between sentences so the OS doesn't suspend the page with the screen off.
// Two layers, because the volume-0 <audio> loop alone is enough on iPhone but NOT on iPad/macOS (those
// treat truly-silent output as "not really playing" and nap the page, stalling the timer that schedules
// the next sentence):
//   1. a looping silent <audio> element (the iPhone-proven path), and
//   2. a near-silent Web Audio oscillator — genuine non-zero PCM on the audio thread keeps the
//      AudioContext clock running in the background, which both reinforces the session on iPad/macOS and
//      lets afterGap() schedule the inter-sentence gap off that clock (see afterGap).
let keepAliveEl: HTMLAudioElement | null = null;
let keepAliveCtx: AudioContext | null = null;
let keepAliveOsc: OscillatorNode | null = null;
const buildSilentWavUrl = (seconds: number): string => {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + numSamples, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);                          // mono, 8-bit
  writeStr(36, 'data'); view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);                    // 8-bit silence = unsigned midpoint
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
};

/** Lazily create the single shared keep-alive AudioContext (reused across autoplay runs). */
const getKeepAliveCtx = (): AudioContext | null => {
  try {
    type AudioContexts = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const page = typeof window !== 'undefined' ? window as Window & AudioContexts : undefined;
    const Ctx = page && (page.AudioContext || page.webkitAudioContext);
    if (!Ctx) return null;
    if (!keepAliveCtx) keepAliveCtx = new Ctx();
    return keepAliveCtx;
  } catch { return null; }
};

// Reference-counted holds on the keep-alive so overlapping owners (background autoplay + an open
// review/search popup) can't tear down each other's audio session: it's suspended only when the LAST
// holder releases. This is also what keeps the media route "hot" across the word→sentence hop in the
// popups — the word plays via speechSynthesis and the sentence via the <audio> element, and holding the
// session open stops iOS from re-activating (and audibly ramping) the route when the sentence starts.
let keepAliveHolds = 0;

/** Ensure the silent keep-alive is running (idempotent). Doubles as the in-gesture unlock (resume the
 *  AudioContext / start the silent loop), so on iOS it must be reached from a user gesture. */
const ensureKeepAliveRunning = (): void => {
  // Layer 1 — looping silent <audio> (the iPhone-proven path).
  try {
    if (!keepAliveEl) {
      keepAliveEl = new Audio(buildSilentWavUrl(2));
      keepAliveEl.loop = true;
      keepAliveEl.volume = 0;
      (keepAliveEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    }
    void keepAliveEl.play().catch(() => { /* retried on the next start */ });
  } catch { /* ignore */ }

  // Layer 2 — near-silent oscillator to keep the AudioContext clock alive in the background (iPad/macOS).
  // The play tap is a user gesture, so resume() is allowed here. The oscillator is started once and left
  // running (an OscillatorNode can't be restarted once stopped); we only suspend the context to stop.
  try {
    const ctx = getKeepAliveCtx();
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* needs a gesture; this call is one */ });
      if (!keepAliveOsc) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00015; // ~-76 dB: inaudible in practice, but genuine non-zero samples
        osc.frequency.value = 440;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        keepAliveOsc = osc;
      }
    }
  } catch { /* ignore */ }
};

/** Suspend the silent keep-alive (idempotent). */
const suspendKeepAlive = (): void => {
  try { keepAliveEl?.pause(); } catch { /* ignore */ }
  // Suspend (don't close) the context so it and the already-started oscillator can be resumed next run.
  try { if (keepAliveCtx && keepAliveCtx.state === 'running') void keepAliveCtx.suspend().catch(() => { /* ignore */ }); } catch { /* ignore */ }
};

/** Prime the keep-alive inside a user gesture WITHOUT taking a hold — starts it running so a later
 *  acquireKeepAlive() from outside a gesture (e.g. an effect after paint) can still resume the context. */
export const primeKeepAlive = (): void => { ensureKeepAliveRunning(); };

/** Take a reference-counted hold on the keep-alive (starting it if idle). Reach from a user gesture on
 *  iOS. Balance every acquire with exactly one releaseKeepAlive(). */
export const acquireKeepAlive = (): void => {
  keepAliveHolds++;
  ensureKeepAliveRunning();
};

/** Release a hold from acquireKeepAlive(); suspends the keep-alive once the last holder releases. */
export const releaseKeepAlive = (): void => {
  keepAliveHolds = Math.max(0, keepAliveHolds - 1);
  if (keepAliveHolds === 0) suspendKeepAlive();
};

/**
 * Run `cb` after `ms`. A setTimeout is ALWAYS set (so behaviour can never regress below the old
 * timeout-only path); additionally, when the keep-alive AudioContext is running, an equal-length silent
 * buffer is scheduled whose onended fires on the audio thread — which keeps firing with the screen off /
 * tab hidden, where setTimeout is throttled or paused. Whichever fires first wins; the other is
 * cancelled. This is what lets sentence autoplay cross the inter-sentence gap in the background on
 * iPad/macOS (iPhone already worked via the <audio> keep-alive). Returns a canceller.
 */
export const afterGap = (ms: number, cb: () => void): (() => void) => {
  let done = false;
  let src: AudioBufferSourceNode | null = null;
  let t: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (t) { clearTimeout(t); t = null; }
    if (src) { try { src.onended = null; src.stop(); } catch { /* ignore */ } src = null; }
  };
  const fire = () => { if (done) return; done = true; cleanup(); cb(); };
  t = setTimeout(fire, ms); // always-present fallback — fires on resume if Web Audio is frozen/unavailable
  const ctx = keepAliveCtx;
  if (ctx && ctx.state === 'running') {
    try {
      const frames = Math.max(1, Math.ceil(ctx.sampleRate * (ms / 1000)));
      src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, frames, ctx.sampleRate); // silent → onended ~`ms` later, audio-thread timed
      src.onended = fire;
      src.connect(ctx.destination); // silent; keeps the node scheduled
      src.start();
    } catch { src = null; }
  }
  return () => { if (done) return; done = true; cleanup(); };
};
