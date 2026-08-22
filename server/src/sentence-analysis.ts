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

function normalizeSentenceAnalysisCandidate(value: Record<string, unknown>): Record<string, unknown> {
  const candidate: Record<string, any> = { ...value };
  if (!isString(candidate.translation) && isString(candidate['']) &&
      ('americanEnglish' in candidate || 'pronunciation' in candidate)) {
    candidate.translation = candidate[''];
  }

  const american = candidate.americanEnglish;
  if (american && typeof american === 'object' && !Array.isArray(american) &&
      Array.isArray(american.evidence) && american.evidence.length > 6) {
    candidate.americanEnglish = { ...american, evidence: american.evidence.slice(0, 6) };
  }

  const pronunciation = candidate.pronunciation;
  if (pronunciation && typeof pronunciation === 'object' && !Array.isArray(pronunciation) &&
      Array.isArray(pronunciation.fastSpeechFeatures)) {
    const fastSpeechFeatures = pronunciation.fastSpeechFeatures
      .map((feature: unknown) => {
        if (isString(feature, 2_000)) return feature;
        if (!feature || typeof feature !== 'object' || Array.isArray(feature)) return '';
        return [...new Set(Object.values(feature).filter(part => isString(part, 2_000)))]
          .join(': ')
          .slice(0, 2_000);
      })
      .filter((feature: string) => feature.length > 0)
      .slice(0, 6);
    if (fastSpeechFeatures.length > 0) {
      candidate.pronunciation = { ...pronunciation, fastSpeechFeatures };
    }
  }
  return candidate;
}

export function sentenceGrammarExcerptMatchesText(text: string, excerpt: string): boolean {
  if (text.includes(excerpt)) return true;
  const withoutSentenceFinalPunctuation = text.replace(/([.!?])([\u201d\u2019"'])$/u, '$2');
  if (withoutSentenceFinalPunctuation.includes(excerpt)) return true;
  const withoutQuotedPunctuation = (value: string) => value.replace(/[,.;:!?](?=[\u201d\u2019"'])/gu, '');
  const withoutLineBreakMarkers = (value: string) => withoutQuotedPunctuation(value).replace(/\s+\/\s+/gu, ' ');
  return withoutLineBreakMarkers(withoutSentenceFinalPunctuation)
    .includes(withoutLineBreakMarkers(excerpt));
}

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

function parseWrappedJson(value: string): unknown | null {
  let content = value.trim();
  if (!content || content.length > 100_000) return null;
  const fence = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) content = fence[1].trim();
  if (!content.startsWith('{') && !content.startsWith('[')) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const PROVIDER_WRAPPER_KEYS = ['grammar', 'analysis', 'result', 'output', 'response', 'data', 'content', ''] as const;

export function extractSentenceGrammarAnalysis(value: unknown, depth = 0): SentenceGrammarAnalysis | null {
  if (isSentenceGrammarAnalysis(value)) return value;
  if (depth >= 4) return null;
  if (typeof value === 'string') {
    const parsed = parseWrappedJson(value);
    return parsed === null ? null : extractSentenceGrammarAnalysis(parsed, depth + 1);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, any>;
  for (const key of PROVIDER_WRAPPER_KEYS) {
    if (!(key in response)) continue;
    const grammar = extractSentenceGrammarAnalysis(response[key], depth + 1);
    if (grammar) return grammar;
  }
  const values = Object.values(response);
  if (values.length === 1) return extractSentenceGrammarAnalysis(values[0], depth + 1);
  return null;
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

export function withLegacyNaturalSpeechIpa(analysis: CompleteSentenceAnalysis): CompleteSentenceAnalysis {
  return { ...analysis, naturalSpeechIpa: analysis.pronunciation.fastIpa };
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

function sentenceAnalysisCandidate(value: unknown, depth = 0): unknown {
  if (depth >= 4 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  if ('translation' in response || 'americanEnglish' in response || 'pronunciation' in response) return value;
  for (const key of PROVIDER_WRAPPER_KEYS) {
    if (key === 'grammar' || !(key in response)) continue;
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

export function extractSentenceAnalysis(
  value: unknown,
  depth = 0,
): CompleteSentenceAnalysis | null {
  if (hasCompleteSentenceAnalysis(value)) return value;
  if (depth >= 4) return null;
  if (typeof value === 'string') {
    const parsed = parseWrappedJson(value);
    return parsed === null ? null : extractSentenceAnalysis(parsed, depth + 1);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const normalized = normalizeSentenceAnalysisCandidate(response);
  if (hasCompleteSentenceAnalysis(normalized)) return normalized;
  for (const key of PROVIDER_WRAPPER_KEYS) {
    if (!(key in response) || key === 'grammar') continue;
    const analysis = extractSentenceAnalysis(response[key], depth + 1);
    if (analysis) return analysis;
  }
  const values = Object.values(response);
  if (values.length === 1) return extractSentenceAnalysis(values[0], depth + 1);
  return null;
}

export const SENTENCE_ANALYSIS_INSTRUCTION = `
You are an expert American English lexicographer and an exacting coach for an advanced Chinese-speaking learner.
Analyze only the supplied English text. Be context-specific, thorough, and factually careful. Return one valid JSON
object and no markdown, commentary, or extra keys.

The JSON keys MUST appear in this exact order:
{
  "translation": "A precise, natural Simplified Chinese translation preserving tense, tone, register, and idiomatic force",
  "americanEnglish": {
    "status": "american | shared | not_american",
    "explanation": "A direct, nuanced English verdict beginning with Yes or No that explains whether the complete sentence is natural in present-day educated American English and in what contexts or register",
    "evidence": ["A concrete lexical, idiomatic, spelling, grammatical, or register reason tied to an exact expression in the sentence"]
  },
  "terms": [
    {
      "term": "The uncommon word, idiom, phrasal verb, or fixed phrase exactly as it appears in context",
      "chinese": "Its context-specific Simplified Chinese translation",
      "ipa": "General American IPA for the term, with stress marks and surrounding slashes",
      "originalMeaning": "In English, explain its core meaning in this context and, for a figurative expression, its literal or earlier sense",
      "synonyms": ["Context-appropriate English synonym"],
      "antonyms": ["Context-appropriate English antonym; use an empty array when none is natural"],
      "examples": ["Two natural, modern American English usage examples"],
      "historicalEvolution": "In English, a concise, accurate note on origin and semantic development"
    }
  ],
  "pronunciation": {
    "slowIpa": "Rhotic General American IPA for the complete sentence spoken deliberately and clearly, with every word boundary recoverable; enclose it in slashes",
    "fastIpa": "Rhotic General American IPA for the complete sentence in fluent connected speech, showing ordinary weak forms, reductions, linking, assimilation, and flapping; enclose it in slashes",
    "carefulSpeakerGuide": "A learner-friendly stress and chunk guide for the complete sentence using ordinary spelling, hyphens, slashes between thought groups, and CAPITALS for primary stress",
    "fastSpeechFeatures": ["An exact source span followed by its specific connected-speech behavior and resulting sound"],
    "intonationAndChunking": "The complete sentence divided into natural thought groups with / and useful rise/fall arrows, followed by a concise explanation of the information focus",
    "keyDifference": "One or two plain-English sentences contrasting careful and fluent delivery in this exact sentence"
  },
  "grammar": {
    "structure": "A compact but complete English map of the sentence structure, naming the main clause and any subordinate clauses, phrases, coordination, or ellipsis in their source order",
    "points": [
      {
        "label": "The specific grammar feature, such as present perfect, reduced relative clause, or inversion",
        "excerpt": "The shortest exact span from the supplied sentence that demonstrates this feature",
        "explanation": "A context-specific English explanation of how the form works here, what meaning or emphasis it contributes, and why this form is used rather than a plausible alternative"
      }
    ]
  },
  "imagePrompt": "A production-ready prompt for one realistic, photorealistic 16:9 image whose central action or relationship makes the complete contextual meaning inferable at a glance. Include every distinguishing detail, keep the scene easy to parse, and depict an idiom's intended meaning rather than a misleading literal origin. Specify people, setting, camera distance, composition, and natural lighting. No illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, or visible text."
}

Rules:
- Everything must be English except translation and each term's chinese field.
- americanEnglish.explanation must answer the naturalness question directly. Evidence must contain 1-6 non-redundant bullet-ready reasons and distinguish "natural in American English" from "uniquely American." For non-American wording, give the natural current American equivalent.
- pronunciation.slowIpa and fastIpa must each transcribe the complete sentence, not isolated words. Use mainstream rhotic General American IPA, never British RP, eye-dialect respelling, exaggerated deletion, or a narrow regional accent. Preserve every meaning-bearing word.
- pronunciation.fastSpeechFeatures must contain 1-6 sentence-specific observations. Name the relevant source words and explain the actual weak form, linking, reduction, flapping, assimilation, or release; do not list generic pronunciation advice.
- The carefulSpeakerGuide is a pronunciation aid, not IPA. Its stress marking and thought groups must agree with both IPA transcriptions and intonationAndChunking.
- grammar.structure must describe this sentence rather than recite a generic grammar rule. Keep it readable and use established grammatical terminology.
- grammar.points must cover every construction an advanced learner needs to parse the sentence correctly, including tense/aspect, modality, clause relationships, nonfinite or reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant. Do not pad a simple sentence with trivial observations.
- Each grammar excerpt must be copied exactly from the supplied text after removing only {{...}} and [[...]] learning markers. Prefer one point for a multiword construction rather than fragmenting it.
- Include every uncommon or non-obvious expression an upper-intermediate Chinese-speaking learner may need here, including central literary, professional, metaphorical, or context-specific words and the studied expression when appropriate.
- Prefer the longest meaningful phrase over duplicating its component words. Preserve source order and do not duplicate terms.
- Do not omit a meaningful B2+ word merely because an advanced reader may recognize it. Do not pad with elementary function words. Return an empty terms array only when the text truly has no expression worth explaining.
- IPA must be rhotic General American, not British RP.
- Synonyms and antonyms must match the sense used in this text, not unrelated dictionary senses.
- Historical claims must be conservative. State uncertainty rather than inventing an etymology.
- Give at least one context-matched synonym and exactly two natural usage examples for every term. Antonyms may be empty only when no context-matched opposite is natural.
- Examples must not quote or merely paraphrase the source sentence.
- Keep fields cleanly separated: originalMeaning contains meaning and semantic clarification only; examples contains usage examples only; historicalEvolution contains origin and chronology only.
`;

function plainSentenceText(text: string): string {
  return text
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
    .trim();
}

export function sentenceAnalysisUserPrompt(text: string): string {
  return `Analyze this text exactly as specified:\n\n${JSON.stringify(plainSentenceText(text))}`;
}

export const SENTENCE_GRAMMAR_INSTRUCTION = `
You are an expert American English grammarian and an exacting coach for an advanced Chinese-speaking learner.
Analyze only the supplied English sentence. Return one valid JSON object and no markdown, commentary, or extra keys.

Return exactly this structure:
{
  "grammar": {
    "structure": "A compact but complete English map of the sentence structure, naming the main clause and any subordinate clauses, phrases, coordination, or ellipsis in their source order",
    "points": [
      {
        "label": "The specific grammar feature",
        "excerpt": "The shortest exact span from the sentence that demonstrates it",
        "explanation": "A context-specific English explanation of how the form works, what meaning or emphasis it contributes, and why it is used rather than a plausible alternative"
      }
    ]
  }
}

Rules:
- Describe this sentence, not a generic textbook rule. Use established grammatical terminology but explain it readably.
- Cover every construction an advanced learner needs to parse the sentence correctly: tense/aspect, modality, clause relationships, nonfinite or reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant.
- Do not pad a simple sentence with trivial observations. The structure summary is still required; points may be empty only when it fully explains a genuinely simple sentence.
- Copy each excerpt exactly from the supplied sentence. Prefer one point for a multiword construction rather than fragmenting it.
- Explain the grammar in English. Do not rewrite or modify any other stored analysis field.
`;

export function sentenceGrammarUserPrompt(text: string, translation?: string): string {
  const context = translation?.trim() ? `\nExisting Chinese translation for sense context: ${JSON.stringify(translation.trim())}` : '';
  return `Add only the missing grammar analysis for this sentence:\n\n${JSON.stringify(plainSentenceText(text))}${context}`;
}
