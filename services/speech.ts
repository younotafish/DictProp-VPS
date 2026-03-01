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

  // Priority: best American English voices first
  return (
    voices.find(v => v.name === 'Samantha') ||              // macOS/iOS native US English
    voices.find(v => v.name === 'Google US English') ||      // Chrome cloud voice
    voices.find(v => v.name === 'Alex') ||                   // macOS native US English
    voices.find(v => v.name.includes('Zira')) ||             // Windows US English
    voices.find(v => v.lang === 'en-US') ||                  // Any en-US voice (incl. Google)
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
    // Chrome bug: cancel() + immediate speak() = silent drop.
    // Stop any current speech, then delay before speaking.
    window.speechSynthesis.cancel();

    // Use setTimeout(0) to let Chrome's internal state settle after cancel()
    setTimeout(() => {
      if (cachedVoice) {
        utterance.voice = cachedVoice;
      }
      window.speechSynthesis.speak(utterance);
    }, 10);
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
