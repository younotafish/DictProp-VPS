import type { SentenceAnalysis } from '../types';

/** A sentence's two IPA lines, either missing when its analysis has none. */
export interface SentencePronunciation {
  /** The careful rendering, each word clearly bounded (pronunciation.slowIpa). */
  citation?: string;
  /**
   * Fluent connected speech (pronunciation.fastIpa, or the legacy naturalSpeechIpa), left out when it reads the
   * same as the careful line.
   */
  connected?: string;
}

/**
 * The connected-speech IPA alone, as the sentence's front page shows it under the sentence: pronunciation.fastIpa,
 * else the legacy naturalSpeechIpa. It's shown even when it reads the same as the careful line, which the front page
 * doesn't show.
 */
export function connectedSpeechIpa(analysis: SentenceAnalysis | undefined): string | undefined {
  return analysis?.pronunciation?.fastIpa || analysis?.naturalSpeechIpa || undefined;
}

/** The analysis page's pair, the careful line and the connected one, with a connected line equal to it left out. */
export function sentencePronunciation(analysis: SentenceAnalysis | undefined): SentencePronunciation {
  const citation = analysis?.pronunciation?.slowIpa || undefined;
  const fast = connectedSpeechIpa(analysis);
  return { citation, connected: fast !== citation ? fast : undefined };
}
