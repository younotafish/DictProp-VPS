/**
 * Shared speech synthesis utilities
 *
 * Chrome on macOS loads voices asynchronously — getVoices() returns []
 * until the voiceschanged event fires (~1-2s after page load). We cache
 * the resolved voice eagerly at module load so it's ready by the time
 * the user interacts.
 *
 * Known Chrome bugs handled:
 * 1. Voices load asynchronously (voiceschanged event)
 * 2. cancel() followed immediately by speak() silently drops the utterance
 * 3. Long utterances (>15s) get cut off — we don't hit this for single words
 */

import { log, warn } from './logger';

/**
 * Get the preferred American English voice for speech synthesis
 * Priority: Samantha (iOS/Mac) > Google US English > Alex (Mac) > Zira (Windows) > any en-US
 */
const getPreferredVoice = (): SpeechSynthesisVoice | undefined => {
  if (!window.speechSynthesis) return undefined;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return undefined;

  // Prefer LOCAL (on-device) voices. Chrome's network voices (e.g. "Google US
  // English") frequently fail silently — the utterance "plays" but no audio is
  // produced — so we only fall back to a network voice if no local one exists.
  const byName = (n: string) => voices.find(v => v.name === n);
  return (
    byName('Samantha') ||                                            // macOS/iOS local US English
    byName('Alex') ||                                                // macOS local US English
    voices.find(v => v.name.includes('Zira')) ||                     // Windows local US English
    voices.find(v => v.lang === 'en-US' && v.localService) ||        // any local en-US
    voices.find(v => v.lang.startsWith('en') && v.localService) ||   // any local English
    byName('Google US English') ||                                   // network fallback
    voices.find(v => v.lang === 'en-US') ||                          // any en-US (incl. network)
    voices.find(v => v.lang.startsWith('en')) ||                     // any English
    undefined
  );
};

// Module-level voice cache — resolved eagerly so it's ready by user interaction
let cachedVoice: SpeechSynthesisVoice | null = null;
let voicesLoaded = false;

const resolveVoices = () => {
  const voices = window.speechSynthesis?.getVoices() || [];
  const voice = getPreferredVoice();
  if (voice) {
    cachedVoice = voice;
    voicesLoaded = true;
    log(`🔊 TTS: Cached voice "${voice.name}" (${voice.lang}) from ${voices.length} available`);
  } else if (voices.length > 0) {
    // Voices loaded but none match our US English priority — mark as loaded
    voicesLoaded = true;
    log(`🔊 TTS: ${voices.length} voices available but none match US English priority. Names: ${voices.slice(0, 5).map(v => v.name).join(', ')}...`);
  }
};

// Eagerly attempt to load voices (works immediately in Safari, Firefox)
if (typeof window !== 'undefined' && window.speechSynthesis) {
  resolveVoices();

  // Chrome fires voiceschanged asynchronously — listen for it
  if (!voicesLoaded) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      log('🔊 TTS: voiceschanged event fired');
      resolveVoices();
    }, { once: true });
  }
}

/**
 * Speak the given text using browser's speech synthesis.
 *
 * Chrome bug workaround: cancel() immediately followed by speak() can
 * silently drop the utterance. We add a small delay after cancel().
 */
export const speak = (
  text: string,
  options?: {
    rate?: number;
    volume?: number;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (event: SpeechSynthesisErrorEvent) => void;
  }
): SpeechSynthesisUtterance | null => {
  if (!window.speechSynthesis) return null;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = options?.rate ?? 0.9;
  utterance.volume = options?.volume ?? 1.0;

  if (options?.onStart) utterance.onstart = options.onStart;
  if (options?.onEnd) utterance.onend = options.onEnd;
  if (options?.onError) utterance.onerror = options.onError;

  const doSpeak = () => {
    const synth = window.speechSynthesis;
    // Chrome can leave the engine stuck in a "paused" state after a previous
    // cancel()/utterance, which makes speak() silently do nothing. resume()
    // un-sticks it (and is harmless when the engine isn't paused).
    try { synth.resume(); } catch {}
    synth.cancel(); // stop anything currently queued/playing

    if (cachedVoice) utterance.voice = cachedVoice;

    // Speak SYNCHRONOUSLY. iOS Safari only honors speak() when it's called
    // directly inside the user-gesture handler — deferring it (the old
    // setTimeout) makes iOS treat it as non-user-initiated and drop it
    // silently. This is safe on Chrome too: the cancel() above is virtually
    // always a no-op here (the button stops playback on the second click
    // rather than re-entering this path mid-utterance).
    synth.speak(utterance);

    // Belt-and-suspenders for the Chrome post-cancel "paused" race: if the
    // engine ends up paused a moment later, kick it back into playing.
    setTimeout(() => { try { if (synth.paused) synth.resume(); } catch {} }, 60);
  };

  if (cachedVoice || voicesLoaded) {
    // Voice cached or voices loaded (even if none matched) — speak now
    doSpeak();
  } else {
    // Voices haven't loaded yet (Chrome async) — wait for them, then speak
    let spoken = false;

    const onVoicesChanged = () => {
      if (spoken) return;
      spoken = true;
      resolveVoices();
      doSpeak();
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true });

    // Timeout fallback: if voiceschanged never fires, speak with browser default
    setTimeout(() => {
      if (!spoken) {
        spoken = true;
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        voicesLoaded = true;
        warn('🔊 TTS: voiceschanged never fired, speaking with default voice');
        doSpeak();
      }
    }, 1500);
  }

  return utterance;
};
