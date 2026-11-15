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

export function sentencePronunciation(analysis: SentenceAnalysis | undefined): SentencePronunciation {
  const citation = analysis?.pronunciation?.slowIpa || undefined;
  const fast = analysis?.pronunciation?.fastIpa || analysis?.naturalSpeechIpa || undefined;
  return { citation, connected: fast !== citation ? fast : undefined };
}
