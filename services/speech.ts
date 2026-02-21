/**
 * Shared speech synthesis utilities
 */

/**
 * Get the preferred English voice for speech synthesis
 * Priority: Samantha (iOS/Mac) > Google US English > Microsoft Zira > any en-US > any en
 */
export const getPreferredVoice = (): SpeechSynthesisVoice | undefined => {
  if (!window.speechSynthesis) return undefined;

  const voices = window.speechSynthesis.getVoices();

  // Priority List:
  // 1. "Samantha" (High quality iOS/Mac)
  // 2. "Google US English" (High quality Android/Chrome)
  // 3. "Microsoft Zira" (High quality Windows)
  // 4. Any "en-US" voice (prefer non-Google to avoid network latency)
  // 5. Any English voice
  let preferredVoice = voices.find(v => v.name === 'Samantha');
  if (!preferredVoice) preferredVoice = voices.find(v => v.name === 'Google US English');
  if (!preferredVoice) preferredVoice = voices.find(v => v.name.includes('Zira'));
  if (!preferredVoice) preferredVoice = voices.find(v => v.lang === 'en-US' && !v.name.includes('Google'));
  if (!preferredVoice) preferredVoice = voices.find(v => v.lang.startsWith('en'));

  return preferredVoice;
};

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

  const preferredVoice = getPreferredVoice();
  if (preferredVoice) {
    utterance.voice = preferredVoice;
  } else {
    // In PWA standalone mode, voices may not be loaded yet
    // Register a one-time listener to set the voice when available
    const onVoicesChanged = () => {
      const voice = getPreferredVoice();
      if (voice) utterance.voice = voice;
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
  }

  if (options?.onStart) utterance.onstart = options.onStart;
  if (options?.onEnd) utterance.onend = options.onEnd;
  if (options?.onError) utterance.onerror = options.onError;

  window.speechSynthesis.speak(utterance);

  return utterance;
};

