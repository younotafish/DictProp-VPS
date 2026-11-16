import type { TtsStyle } from '../ttsSettings';

/**
 * Cached clips are keyed by a voice token (the casual token MUST match the server's CASUAL_STYLE, in
 * server/src/tts/cache.ts). Each speech style plays the clips of its tokens in order of preference and asks the
 * server to generate the last one. Today each style has a single token; a voice rollout puts the new token first.
 *
 * MiMo remains the production default while the offline replacement undergoes a blinded connected-speech
 * benchmark. Imported Qwen clips retain their immutable cache keys on the server, but the client must not prefer
 * them until a perceptual recipe is approved.
 */
export interface StyleVoices {
  /** Tokens whose clips the style plays, best first. */
  readonly play: readonly string[];
  /** The token the server generates a missing clip for. */
  readonly generate: string;
}

export const STYLE_VOICES: Readonly<Record<TtsStyle, StyleVoices>> = {
  clear: { play: ['Mia'], generate: 'Mia' },
  casual: { play: ['casual'], generate: 'casual' },
};
