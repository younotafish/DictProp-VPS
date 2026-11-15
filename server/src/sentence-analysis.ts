// The detailed sentence-analysis contract the server enforces on stored sentences. The local cycle on the Mac writes
// these analyses (its prompts and repair helpers are in scripts/offline/sentence-analysis-contract.mjs); the VPS
// only validates them. sentenceAnalysisValidationIssues phrases a failed check as repair instructions for that
// cycle. This module has no imports, so the offline scripts can load it under plain node.

export type AmericanEnglishStatus = 'american' | 'shared' | 'not_american';

export interface SentenceAnalysisTerm {
  term: string;
  chinese: string;
  ipa: string;
  originalMeaning: string;
  synonyms: string[];
  antonyms: string[];
  examples: string[];
  historicalEvolution: string;
}

export interface SentenceGrammarPoint {
  label: string;
  excerpt: string;
  explanation: string;
}

export interface SentenceGrammarAnalysis {
  structure: string;
  points: SentenceGrammarPoint[];
}

export interface SentencePronunciationGuide {
  slowIpa: string;
  fastIpa: string;
  carefulSpeakerGuide: string;
  fastSpeechFeatures: string[];
  intonationAndChunking: string;
  keyDifference: string;
}

export interface SentenceAnalysis {
  translation: string;
  naturalSpeechIpa?: string;
  grammar?: SentenceGrammarAnalysis;
  americanEnglish: {
    status: AmericanEnglishStatus;
    explanation: string;
    evidence?: string[];
  };
  terms: SentenceAnalysisTerm[];
  pronunciation?: SentencePronunciationGuide;
  imagePrompt: string;
}

export interface CompleteSentenceAnalysis extends SentenceAnalysis {
  grammar: SentenceGrammarAnalysis;
  americanEnglish: SentenceAnalysis['americanEnglish'] & { evidence: string[] };
  pronunciation: SentencePronunciationGuide;
}

const STATUSES = new Set<AmericanEnglishStatus>(['american', 'shared', 'not_american']);
const MAX_TEXT_LENGTH = 12_000;
const MAX_TERMS = 20;
const MAX_LIST_ITEMS = 12;
const MAX_GRAMMAR_POINTS = 12;
const SLASH_DELIMITED_IPA = /^\/[^/\n]+\/$/;

const isString = (value: unknown, max = MAX_TEXT_LENGTH): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const isStringList = (value: unknown, maxItems = MAX_LIST_ITEMS): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => isString(item, 2_000));

export function isSentencePronunciationGuide(value: unknown): value is SentencePronunciationGuide {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pronunciation = value as Record<string, any>;
  return isString(pronunciation.slowIpa, 2_000) && SLASH_DELIMITED_IPA.test(pronunciation.slowIpa.trim()) &&
    isString(pronunciation.fastIpa, 2_000) && SLASH_DELIMITED_IPA.test(pronunciation.fastIpa.trim()) &&
    isString(pronunciation.carefulSpeakerGuide, 4_000) &&
    isStringList(pronunciation.fastSpeechFeatures, 6) &&
    isString(pronunciation.intonationAndChunking, 4_000) &&
    isString(pronunciation.keyDifference, 4_000);
}

export function isSentenceGrammarAnalysis(value: unknown): value is SentenceGrammarAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grammar = value as Record<string, any>;
  return isString(grammar.structure, 4_000) &&
    Array.isArray(grammar.points) && grammar.points.length <= MAX_GRAMMAR_POINTS &&
    grammar.points.every((point: any) =>
      point && typeof point === 'object' && !Array.isArray(point) &&
      isString(point.label, 300) && isString(point.excerpt, 1_000) &&
      isString(point.explanation, 4_000)
    );
}

export function hasSentenceGrammarAnalysis(
  value: unknown,
): value is SentenceAnalysis & { grammar: SentenceGrammarAnalysis } {
  return isSentenceAnalysis(value) && isSentenceGrammarAnalysis(value.grammar);
}

export function hasCompleteSentenceAnalysis(value: unknown): value is CompleteSentenceAnalysis {
  if (!isSentenceAnalysis(value) || !isSentenceGrammarAnalysis(value.grammar) ||
      !isSentencePronunciationGuide(value.pronunciation)) return false;
  if (!Array.isArray(value.americanEnglish.evidence) || value.americanEnglish.evidence.length === 0) return false;
  if (value.pronunciation.fastSpeechFeatures.length === 0) return false;
  if (value.naturalSpeechIpa !== undefined &&
      value.naturalSpeechIpa.trim() !== value.pronunciation.fastIpa.trim()) return false;
  return value.terms.every(term => term.synonyms.length > 0 && term.examples.length === 2);
}

export function isSentenceAnalysis(value: unknown): value is SentenceAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const analysis = value as Record<string, any>;
  const american = analysis.americanEnglish;
  if (!isString(analysis.translation) || !isString(analysis.imagePrompt, 4_000)) return false;
  if (analysis.naturalSpeechIpa !== undefined && !isString(analysis.naturalSpeechIpa, 2_000)) return false;
  if (analysis.grammar !== undefined && !isSentenceGrammarAnalysis(analysis.grammar)) return false;
  if (analysis.pronunciation !== undefined && !isSentencePronunciationGuide(analysis.pronunciation)) return false;
  if (!american || typeof american !== 'object' || Array.isArray(american) ||
      !STATUSES.has(american.status) || !isString(american.explanation, 4_000)) return false;
  if (american.evidence !== undefined && !isStringList(american.evidence, 6)) return false;
  if (!Array.isArray(analysis.terms) || analysis.terms.length > MAX_TERMS) return false;
  return analysis.terms.every((term: any) =>
    term && typeof term === 'object' && !Array.isArray(term) &&
    isString(term.term, 300) && isString(term.chinese, 1_000) && isString(term.ipa, 500) &&
    isString(term.originalMeaning, 4_000) && isStringList(term.synonyms) &&
    isStringList(term.antonyms) && isStringList(term.examples, 5) &&
    isString(term.historicalEvolution, 4_000)
  );
}

// Keys a provider may wrap its answer in.
const PROVIDER_WRAPPER_KEYS = ['analysis', 'result', 'output', 'response', 'data', 'content', ''] as const;

function sentenceAnalysisCandidate(value: unknown, depth = 0): unknown {
  if (depth >= 4 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  if ('translation' in response || 'americanEnglish' in response || 'pronunciation' in response) return value;
  for (const key of PROVIDER_WRAPPER_KEYS) {
    if (!(key in response)) continue;
    const candidate = sentenceAnalysisCandidate(response[key], depth + 1);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return value;
}

export function sentenceAnalysisValidationIssues(value: unknown): string[] {
  const candidate = sentenceAnalysisCandidate(value);
  if (hasCompleteSentenceAnalysis(candidate)) return [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return ['the response must be one JSON object'];
  }
  const analysis = candidate as Record<string, any>;
  const issues: string[] = [];
  const american = analysis.americanEnglish;
  const pronunciation = analysis.pronunciation;
  const grammar = analysis.grammar;

  if (!isString(analysis.translation)) issues.push('translation must be a non-empty string');
  if (!isString(analysis.imagePrompt, 4_000)) issues.push('imagePrompt must be a non-empty string');
  if (!american || typeof american !== 'object' || Array.isArray(american)) {
    issues.push('americanEnglish must be an object');
  } else {
    if (!STATUSES.has(american.status)) issues.push('americanEnglish.status must be american, shared, or not_american');
    if (!isString(american.explanation, 4_000)) issues.push('americanEnglish.explanation must be a non-empty string');
    if (!isStringList(american.evidence, 6) || american.evidence.length === 0) {
      issues.push('americanEnglish.evidence must contain 1-6 non-empty strings');
    }
  }

  if (!Array.isArray(analysis.terms) || analysis.terms.length > MAX_TERMS) {
    issues.push(`terms must be an array with at most ${MAX_TERMS} entries`);
  } else {
    analysis.terms.forEach((term: any, index: number) => {
      if (!term || typeof term !== 'object' || Array.isArray(term)) {
        issues.push(`terms[${index}] must be an object`);
        return;
      }
      if (!isString(term.term, 300) || !isString(term.chinese, 1_000) ||
          !isString(term.ipa, 500) || !isString(term.originalMeaning, 4_000) ||
          !isString(term.historicalEvolution, 4_000)) {
        issues.push(`terms[${index}] is missing a required non-empty string field`);
      }
      if (!isStringList(term.synonyms) || term.synonyms.length === 0) {
        issues.push(`terms[${index}].synonyms must contain at least one string`);
      }
      if (!isStringList(term.antonyms)) issues.push(`terms[${index}].antonyms must be a string array`);
      if (!isStringList(term.examples, 5) || term.examples.length !== 2) {
        issues.push(`terms[${index}].examples must contain exactly two strings`);
      }
    });
  }

  if (!pronunciation || typeof pronunciation !== 'object' || Array.isArray(pronunciation)) {
    issues.push('pronunciation must be an object');
  } else {
    if (!isString(pronunciation.slowIpa, 2_000) || !SLASH_DELIMITED_IPA.test(pronunciation.slowIpa.trim())) {
      issues.push('pronunciation.slowIpa must be complete IPA enclosed in slashes');
    }
    if (!isString(pronunciation.fastIpa, 2_000) || !SLASH_DELIMITED_IPA.test(pronunciation.fastIpa.trim())) {
      issues.push('pronunciation.fastIpa must be complete IPA enclosed in slashes');
    }
    if (!isString(pronunciation.carefulSpeakerGuide, 4_000)) {
      issues.push('pronunciation.carefulSpeakerGuide must be a non-empty string');
    }
    if (!isStringList(pronunciation.fastSpeechFeatures, 6) || pronunciation.fastSpeechFeatures.length === 0) {
      issues.push('pronunciation.fastSpeechFeatures must contain 1-6 strings');
    }
    if (!isString(pronunciation.intonationAndChunking, 4_000)) {
      issues.push('pronunciation.intonationAndChunking must be a non-empty string');
    }
    if (!isString(pronunciation.keyDifference, 4_000)) {
      issues.push('pronunciation.keyDifference must be a non-empty string');
    }
  }

  if (!isSentenceGrammarAnalysis(grammar)) issues.push('grammar must contain a structure and valid points');
  if (analysis.naturalSpeechIpa !== undefined &&
      (!isString(analysis.naturalSpeechIpa, 2_000) ||
       !pronunciation || analysis.naturalSpeechIpa.trim() !== pronunciation.fastIpa?.trim())) {
    issues.push('naturalSpeechIpa, when present, must equal pronunciation.fastIpa');
  }
  return issues.length > 0 ? issues : ['the response does not satisfy the complete sentence-analysis contract'];
}
