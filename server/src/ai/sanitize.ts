// Model output reduced to what the client can render: comparisons and vocabulary-scan entries. The accept functions
// turn a reply into a route's result, or reject it as unusable so the chat client asks once more.
import { AiError } from '../ai-client.js';

// A vocabulary scan returns at most this many expressions (the scan prompt asks for no more than 12).
export const MAX_EXTRACTED_WORDS = 12;

export const trimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A map of non-empty strings under non-empty keys; anything else (numbers, objects, blanks) is dropped. */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const word = key.trim();
    const text = trimmedString(entry);
    return word && text ? [[word, text] as [string, string]] : [];
  }));
}

export interface ComparisonDimension {
  label: string;
  analysis: string;
  perWord: Record<string, string>;
}

export interface ComparisonExample {
  context: string;
  sentences: Record<string, string>;
}

export interface Comparison {
  words: string[];
  summary: string;
  dimensions: ComparisonDimension[];
  examples: ComparisonExample[];
  commonMistakes: string[];
  verdict: string;
}

/**
 * Keep only what the comparison view can render: string-only per-word maps, dimensions with a label
 * and some content, examples with at least one sentence. Null when no dimension survives.
 */
export function sanitizeComparison(raw: Record<string, unknown>, requestedWords: string[]): Comparison | null {
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).flatMap((dimension: unknown) => {
    if (!dimension || typeof dimension !== 'object') return [];
    const fields = dimension as Record<string, unknown>;
    const label = trimmedString(fields.label);
    const analysis = trimmedString(fields.analysis);
    const perWord = stringMap(fields.perWord);
    return label && (analysis || Object.keys(perWord).length > 0) ? [{ label, analysis, perWord }] : [];
  });
  if (dimensions.length === 0) return null;
  const examples = (Array.isArray(raw.examples) ? raw.examples : []).flatMap((example: unknown) => {
    if (!example || typeof example !== 'object') return [];
    const fields = example as Record<string, unknown>;
    const sentences = stringMap(fields.sentences);
    return Object.keys(sentences).length > 0 ? [{ context: trimmedString(fields.context), sentences }] : [];
  });
  const modelWords = Array.isArray(raw.words) ? raw.words.map(trimmedString) : [];
  return {
    words: modelWords.length === requestedWords.length && modelWords.every(Boolean) ? modelWords : requestedWords,
    summary: trimmedString(raw.summary),
    dimensions,
    examples,
    commonMistakes: (Array.isArray(raw.commonMistakes) ? raw.commonMistakes : []).map(trimmedString).filter(Boolean),
    verdict: trimmedString(raw.verdict),
  };
}

export interface DetectedWord {
  word: string;
  context: string;
  level: string;
  reason: string;
}

/** Only the four scan fields, trimmed; the same expression (ignoring case and spacing) is kept once; at most 12. */
export function sanitizeDetectedWords(value: unknown): DetectedWord[] {
  const seen = new Set<string>();
  const words: DetectedWord[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { word, context, level, reason } = entry as Record<string, unknown>;
    if (typeof word !== 'string' || !word.trim() ||
        typeof context !== 'string' || typeof level !== 'string' || typeof reason !== 'string') continue;
    const key = word.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ word: word.trim(), context: context.trim(), level: level.trim(), reason: reason.trim() });
    if (words.length === MAX_EXTRACTED_WORDS) break;
  }
  return words;
}

/** The words a comparison covers: trimmed, at most 100 characters each, the same word (ignoring case) once. */
export function uniqueCompareWords(words: unknown[]): string[] {
  const seen = new Set<string>();
  return words
    .map((w: unknown) => trimmedString(w))
    .filter((w: string) => {
      const key = w.toLowerCase();
      if (!w || w.length > 100 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** A comparison the view can render; a reply with no usable dimension is unusable. */
export const acceptComparison = (requestedWords: string[]) => (reply: Record<string, unknown>): Comparison => {
  const comparison = sanitizeComparison(reply, requestedWords);
  if (!comparison) throw new AiError('invalid', 'The comparison had no usable dimensions');
  return comparison;
};

export interface VocabularyScan {
  /** Empty when the text has nothing worth studying. */
  words: DetectedWord[];
  /** The English the model scanned when the input was Chinese, else ''. */
  translation: string;
  sourceLang: 'zh' | 'en';
}

/** A vocabulary scan; a reply without a words list, or whose every entry is malformed, is unusable. */
export function acceptVocabularyScan(reply: Record<string, unknown>): VocabularyScan {
  if (!Array.isArray(reply.words)) throw new AiError('invalid', 'The vocabulary scan had no "words" array');
  const words = sanitizeDetectedWords(reply.words);
  if (words.length === 0 && reply.words.length > 0) throw new AiError('invalid', 'Every detected word was malformed');
  return {
    words,
    translation: typeof reply.translation === 'string' ? reply.translation : '',
    sourceLang: reply.sourceLang === 'zh' ? 'zh' : 'en',
  };
}
