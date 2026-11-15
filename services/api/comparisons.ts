import type { ComparisonResult, StoredComparison } from '../../types';
import { jsonRequest, requestJson, requestVoid } from '../http';
import { stringRecord, textOrEmpty } from './json';

// Comparisons: the cleaning every comparison goes through before the view renders it, and the comparisons saved on
// the server (persisted side-by-side analyses, keyed by the word-set).

// Keeps only the well-formed parts of a comparison. The comparison view renders these fields directly,
// and a saved comparison opens on every device, so one non-string value must not reach it.
export const sanitizeComparisonResult = (data: any, fallbackWords: string[]): ComparisonResult => {
  const resultWords = Array.isArray(data?.words) && data.words.length > 0 &&
    data.words.every((word: unknown) => typeof word === 'string' && word.trim())
    ? data.words as string[]
    : fallbackWords;
  return {
    words: resultWords,
    summary: textOrEmpty(data?.summary),
    dimensions: (Array.isArray(data?.dimensions) ? data.dimensions : [])
      .filter((dimension: any) => dimension && typeof dimension.label === 'string' && dimension.label)
      .map((dimension: any) => ({
        label: dimension.label,
        analysis: textOrEmpty(dimension.analysis),
        perWord: stringRecord(dimension.perWord),
      })),
    examples: (Array.isArray(data?.examples) ? data.examples : [])
      .filter((example: any) => example && typeof example === 'object')
      .map((example: any) => ({ context: textOrEmpty(example.context), sentences: stringRecord(example.sentences) }))
      .filter((example: { sentences: Record<string, string> }) => Object.keys(example.sentences).length > 0),
    commonMistakes: (Array.isArray(data?.commonMistakes) ? data.commonMistakes : [])
      .filter((mistake: unknown): mistake is string => typeof mistake === 'string' && mistake.trim().length > 0),
    verdict: textOrEmpty(data?.verdict),
  };
};

export const loadComparisons = async (): Promise<StoredComparison[]> => {
  const stored = await requestJson<unknown>(
    '/api/comparisons',
    undefined,
    'Load comparisons',
  );
  // Comparisons saved before /api/compare validated its output can hold non-string values; clean them
  // for display (nothing here is written back).
  return (Array.isArray(stored) ? stored : [])
    .filter((entry: any) => entry && typeof entry === 'object')
    .map((entry: any) => {
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
