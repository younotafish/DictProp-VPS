/**
 * Shared speech synthesis utilities
 *
 * Chrome on macOS loads voices asynchronously — getVoices() returns []
 * until the voiceschanged event fires (~1-2s after page load). We cache
 * the resolved voice eagerly at module load so it's ready by the time
 * the user interacts. If speak() is called before voices load, we wait
 * for voiceschanged and retry, with a 1.5s timeout fallback.
 */

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
  const voice = getPreferredVoice();
  if (voice) {
    cachedVoice = voice;
    voicesLoaded = true;
  }
};

// Eagerly attempt to load voices (works immediately in Safari, Firefox)
if (typeof window !== 'undefined' && window.speechSynthesis) {
  resolveVoices();

  // Chrome fires voiceschanged asynchronously — listen for it
  if (!voicesLoaded) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      resolveVoices();
    }, { once: true });
  }
}

/**
 * Speak the given text using browser's speech synthesis
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

  // Stop any current speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = options?.rate ?? 0.9;
  utterance.volume = options?.volume ?? 1.0;

  if (options?.onStart) utterance.onstart = options.onStart;
  if (options?.onEnd) utterance.onend = options.onEnd;
  if (options?.onError) utterance.onerror = options.onError;

  if (cachedVoice) {
    // Voice already cached — speak immediately
    utterance.voice = cachedVoice;
    window.speechSynthesis.speak(utterance);
  } else if (!voicesLoaded) {
    // Voices haven't loaded yet (Chrome async) — wait for them, then speak
    const onVoicesChanged = () => {
      resolveVoices();
      if (cachedVoice) utterance.voice = cachedVoice;
      window.speechSynthesis.speak(utterance);
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true });

    // Timeout fallback: if voiceschanged never fires, speak with browser default
    setTimeout(() => {
      if (!voicesLoaded) {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        voicesLoaded = true; // prevent future waits
        window.speechSynthesis.speak(utterance);
      }
    }, 1500);
  } else {
    // Voices loaded but none matched our priority list — speak with browser default
    window.speechSynthesis.speak(utterance);
  }

  return utterance;
};
