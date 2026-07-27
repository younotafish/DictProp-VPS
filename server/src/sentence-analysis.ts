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

export interface SentenceAnalysis {
  translation: string;
  naturalSpeechIpa?: string;
  grammar?: SentenceGrammarAnalysis;
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
const MAX_GRAMMAR_POINTS = 12;

const isString = (value: unknown, max = MAX_TEXT_LENGTH): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const isStringList = (value: unknown, maxItems = MAX_LIST_ITEMS): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => isString(item, 2_000));

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

export function isSentenceAnalysis(value: unknown): value is SentenceAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const analysis = value as Record<string, any>;
  const american = analysis.americanEnglish;
  if (!isString(analysis.translation) || !isString(analysis.imagePrompt, 4_000)) return false;
  if (analysis.naturalSpeechIpa !== undefined && !isString(analysis.naturalSpeechIpa, 2_000)) return false;
  if (analysis.grammar !== undefined && !isSentenceGrammarAnalysis(analysis.grammar)) return false;
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

export function extractSentenceAnalysis(
  value: unknown,
  depth = 0,
): (SentenceAnalysis & { grammar: SentenceGrammarAnalysis }) | null {
  if (hasSentenceGrammarAnalysis(value)) return value;
  if (depth >= 4) return null;
  if (typeof value === 'string') {
    const parsed = parseWrappedJson(value);
    return parsed === null ? null : extractSentenceAnalysis(parsed, depth + 1);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
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
Analyze only the supplied English text. Be context-specific, concise, and factually careful. Return one valid JSON
object and no markdown, commentary, or extra keys.

The JSON keys MUST appear in this exact order:
{
  "translation": "A precise, natural Simplified Chinese translation preserving tense, tone, register, and idiomatic force",
  "naturalSpeechIpa": "Readable rhotic General American IPA for the complete sentence as spoken fluently at a naturally fast conversational pace, with ordinary weak forms, reductions, linking, assimilation, and flapping where they normally occur; enclose the complete transcription in slashes",
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
- naturalSpeechIpa must transcribe the complete sentence, not isolated dictionary forms. Model mainstream natural connected speech, not exaggerated casual deletion or a regional accent. Preserve every meaning-bearing word, use IPA symbols rather than respelling, and return one slash-delimited transcription.
- grammar.structure must describe this sentence rather than recite a generic grammar rule. Keep it readable and use established grammatical terminology.
- grammar.points must cover every construction an advanced learner needs to parse the sentence correctly, including tense/aspect, modality, clause relationships, nonfinite or reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant. Do not pad a simple sentence with trivial observations.
- Each grammar excerpt must be copied exactly from the supplied text after removing only {{...}} and [[...]] learning markers. Prefer one point for a multiword construction rather than fragmenting it.
- Include every genuinely uncommon or non-obvious expression, including the studied expression when appropriate.
- Prefer the longest meaningful phrase over duplicating its component words. Preserve source order and do not duplicate terms.
- Do not pad the list with ordinary A1-B2 words. Return an empty terms array when the text has no uncommon expression.
- IPA must be rhotic General American, not British RP.
- Synonyms and antonyms must match the sense used in this text, not unrelated dictionary senses.
- Historical claims must be conservative. State uncertainty rather than inventing an etymology.
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
