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

export interface SentenceAnalysis {
  translation: string;
  americanEnglish: {
    status: AmericanEnglishStatus;
    explanation: string;
  };
  terms: SentenceAnalysisTerm[];
  imagePrompt: string;
}

const STATUSES = new Set<AmericanEnglishStatus>(['american', 'shared', 'not_american']);
const MAX_TEXT_LENGTH = 12_000;
const MAX_TERMS = 20;
const MAX_LIST_ITEMS = 12;

const isString = (value: unknown, max = MAX_TEXT_LENGTH): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const isStringList = (value: unknown, maxItems = MAX_LIST_ITEMS): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => isString(item, 2_000));

export function isSentenceAnalysis(value: unknown): value is SentenceAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const analysis = value as Record<string, any>;
  const american = analysis.americanEnglish;
  if (!isString(analysis.translation) || !isString(analysis.imagePrompt, 4_000)) return false;
  if (!american || typeof american !== 'object' || Array.isArray(american) ||
      !STATUSES.has(american.status) || !isString(american.explanation, 4_000)) return false;
  if (!Array.isArray(analysis.terms) || analysis.terms.length > MAX_TERMS) return false;
  return analysis.terms.every((term: any) =>
    term && typeof term === 'object' && !Array.isArray(term) &&
    isString(term.term, 300) && isString(term.chinese, 1_000) && isString(term.ipa, 500) &&
    isString(term.originalMeaning, 4_000) && isStringList(term.synonyms) &&
    isStringList(term.antonyms) && isStringList(term.examples, 5) &&
    isString(term.historicalEvolution, 4_000)
  );
}

export const SENTENCE_ANALYSIS_INSTRUCTION = `
You are an expert American English lexicographer and an exacting coach for an advanced Chinese-speaking learner.
Analyze only the supplied English text. Be context-specific, concise, and factually careful. Return one valid JSON
object and no markdown, commentary, or extra keys.

The JSON keys MUST appear in this exact order:
{
  "translation": "A precise, natural Simplified Chinese translation preserving tense, tone, register, and idiomatic force",
  "americanEnglish": {
    "status": "american | shared | not_american",
    "explanation": "In English, say whether the wording is distinctly American, shared across major English varieties, or non-American, and identify the concrete lexical, spelling, grammar, or idiom evidence. Do not call a universal expression American merely because Americans use it. For non-American wording, give the natural present-day American equivalent."
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
  "imagePrompt": "A production-ready prompt for one realistic, photorealistic 16:9 image whose central action or relationship makes the complete contextual meaning inferable at a glance. Include every distinguishing detail, keep the scene easy to parse, and depict an idiom's intended meaning rather than a misleading literal origin. Specify people, setting, camera distance, composition, and natural lighting. No illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, or visible text."
}

Rules:
- Everything must be English except translation and each term's chinese field.
- Include every genuinely uncommon or non-obvious expression, including the studied expression when appropriate.
- Prefer the longest meaningful phrase over duplicating its component words. Preserve source order and do not duplicate terms.
- Do not pad the list with ordinary A1-B2 words. Return an empty terms array when the text has no uncommon expression.
- IPA must be rhotic General American, not British RP.
- Synonyms and antonyms must match the sense used in this text, not unrelated dictionary senses.
- Historical claims must be conservative. State uncertainty rather than inventing an etymology.
- Examples must not quote or merely paraphrase the source sentence.
- Keep fields cleanly separated: originalMeaning contains meaning and semantic clarification only; examples contains usage examples only; historicalEvolution contains origin and chronology only.
`;

export function sentenceAnalysisUserPrompt(text: string): string {
  return `Analyze this text exactly as specified:\n\n${JSON.stringify(text.trim())}`;
}
