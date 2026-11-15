import type { ComparisonResult, StoredComparison } from '../../types';
import { jsonRequest, requestJson, requestVoid } from '../http';
import { stringRecord, textOrEmpty } from './json';

// Comparisons: the cleaning every comparison goes through before the view renders it, and the comparisons saved on
// the server (persisted side-by-side analyses, keyed by the word-set).

// A comparison as it arrives, from /api/compare or saved on the server: any part may be missing or malformed.
interface RawComparison {
  words?: unknown;
  summary?: unknown;
  dimensions?: unknown;
  examples?: unknown;
  commonMistakes?: unknown;
  verdict?: unknown;
}

interface RawDimension {
  label?: unknown;
  analysis?: unknown;
  perWord?: unknown;
}

interface RawExample {
  context?: unknown;
  sentences?: unknown;
}

// Keeps only the well-formed parts of a comparison. The comparison view renders these fields directly,
// and a saved comparison opens on every device, so one non-string value must not reach it.
export const sanitizeComparisonResult = (comparison: unknown, fallbackWords: string[]): ComparisonResult => {
  const data = comparison as RawComparison | null | undefined;
  const resultWords = Array.isArray(data?.words) && data.words.length > 0 &&
    data.words.every((word: unknown) => typeof word === 'string' && word.trim())
    ? data.words as string[]
    : fallbackWords;
  return {
    words: resultWords,
    summary: textOrEmpty(data?.summary),
    dimensions: (Array.isArray(data?.dimensions) ? data.dimensions : [])
      .filter((dimension: RawDimension | null): dimension is RawDimension & { label: string } =>
        !!dimension && typeof dimension.label === 'string' && dimension.label !== '')
      .map(dimension => ({
        label: dimension.label,
        analysis: textOrEmpty(dimension.analysis),
        perWord: stringRecord(dimension.perWord),
      })),
    examples: (Array.isArray(data?.examples) ? data.examples : [])
      .filter((example: RawExample | null): example is RawExample => !!example && typeof example === 'object')
      .map(example => ({ context: textOrEmpty(example.context), sentences: stringRecord(example.sentences) }))
      .filter((example: { sentences: Record<string, string> }) => Object.keys(example.sentences).length > 0),
    commonMistakes: (Array.isArray(data?.commonMistakes) ? data.commonMistakes : [])
      .filter((mistake: unknown): mistake is string => typeof mistake === 'string' && mistake.trim().length > 0),
    verdict: textOrEmpty(data?.verdict),
  };
};

// A comparison as saved: its words and result are cleaned before display, the rest is kept as saved.
type SavedComparison = Omit<StoredComparison, 'words' | 'data'> & { words?: unknown; data?: unknown };

export const loadComparisons = async (): Promise<StoredComparison[]> => {
  const stored = await requestJson<unknown>(
    '/api/comparisons',
    undefined,
    'Load comparisons',
  );
  // Comparisons saved before /api/compare validated its output can hold non-string values; clean them
  // for display (nothing here is written back).
  return (Array.isArray(stored) ? stored : [])
    .filter((entry: SavedComparison | null): entry is SavedComparison => !!entry && typeof entry === 'object')
    .map((entry): StoredComparison => {
      const words = (Array.isArray(entry.words) ? entry.words : [])
        .filter((word: unknown): word is string => typeof word === 'string');
      return { ...entry, words, data: sanitizeComparisonResult(entry.data, words) };
    });
};

export const saveComparisonApi = async (comparison: StoredComparison): Promise<void> => {
  return requestVoid(
    '/api/comparisons',
    jsonRequest('PUT', comparison),
    'Save comparison',
  );
};
