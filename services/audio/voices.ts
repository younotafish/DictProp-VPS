import { TTS_CASUAL_VOICE, TTS_LEGACY_CASUAL_VOICE, TTS_LEGACY_VOICE, TTS_VOICE } from '../api';
import type { TtsStyle } from '../ttsSettings';

/**
 * Cached clips are keyed by a voice token (the casual token MUST match the server's CASUAL_STYLE). Each speech
 * style plays the clips of its tokens in order of preference and asks the server to generate the last one. Today
 * each style has a single token; a voice rollout puts the new token first (see the note in services/api/tts.ts).
 */
export interface StyleVoices {
  /** Tokens whose clips the style plays, best first. */
  readonly play: readonly string[];
  /** The token the server generates a missing clip for. */
  readonly generate: string;
}

const styleVoices = (production: string, generated: string): StyleVoices => ({
  play: production === generated ? [production] : [production, generated],
  generate: generated,
});

export const STYLE_VOICES: Readonly<Record<TtsStyle, StyleVoices>> = {
  clear: styleVoices(TTS_VOICE, TTS_LEGACY_VOICE),
  casual: styleVoices(TTS_CASUAL_VOICE, TTS_LEGACY_CASUAL_VOICE),
};
