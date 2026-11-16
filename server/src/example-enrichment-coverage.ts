import type { AuditedItem } from './incremental-enrichment.js';
import { fieldsOf } from './local-enrichment-markers.js';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { exampleSentenceId, normalizeSentenceLookup, sentenceLookupHash } from './sentence-lookup.js';

/** A stored example enrichment, as the audits and the corpus export read it. */
export interface StoredSentenceEnrichmentRecord {
  lookup_hash: string;
  analysis: string;
  /** The row's image reference, whether or not its blob is still there. */
  image_content_hash: string | null;
  /** The referenced blob's size; null when the row has no image or its blob is gone. */
  image_bytes: number | null;
  updated_at: number;
}

/**
 * What each expected example's stored row covers, as bit flags that keep the map small although analyses run to
 * kilobytes: 1 the row exists, 2 its detailed analysis is complete, 4 its image is stored.
 */
export type StoredExampleCoverage = ReadonlyMap<string, number>;

export interface ExampleEnrichmentCoverage {
  expected: number;
  fullyEnriched: number;
  completeDetailedAnalysis: number;
  missingAnalysis: number;
  incompleteDetailedAnalysis: number;
  withImage: number;
  missingImage: number;
  missingAnalysisIds: string[];
  incompleteDetailedAnalysisIds: string[];
  missingImageIds: string[];
}

const sample = (values: string[], limit = 100): string[] => values.slice(0, limit);

/** A stored analysis, or undefined when its text isn't JSON: a malformed row counts as incomplete, never as an error. */
export function parseStoredAnalysis(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The coverage flags a stored row gives its example. */
export const storedExampleFlags = (analysis: unknown, imageBytes: number | null): number =>
  1 | (hasCompleteSentenceAnalysis(analysis) ? 2 : 0) | (imageBytes !== null && imageBytes > 0 ? 4 : 0);

/**
 * Reads the stored rows once: the flags of each expected example (rows for any other sentence are skipped unparsed)
 * and the newest row's update time, which is when the local cycle last published an example.
 */
export function readStoredExampleCoverage(
  records: Iterable<StoredSentenceEnrichmentRecord>,
  expectedHashes: ReadonlySet<string>,
): { coverage: Map<string, number>; latestUpdatedAt: number } {
  const coverage = new Map<string, number>();
  let latestUpdatedAt = 0;
  for (const record of records) {
    latestUpdatedAt = Math.max(latestUpdatedAt, record.updated_at);
    if (!expectedHashes.has(record.lookup_hash)) continue;
    coverage.set(record.lookup_hash, storedExampleFlags(parseStoredAnalysis(record.analysis), record.image_bytes));
  }
  return { coverage, latestUpdatedAt };
}

/**
 * The lookup hashes of the examples on live cards that need an enrichment row of their own, in the order the id
 * samples follow. A saved sentence owns its analysis and image directly, so an example it matches needs no row.
 */
export function collectExpectedExampleSentenceHashes(items: readonly AuditedItem[]): string[] {
  const savedSentenceHashes = new Set<string>();
  for (const item of items) {
    if (item?.isDeleted || item?.type !== 'sentence') continue;
    const { text } = fieldsOf(item.data);
    if (typeof text === 'string' && normalizeSentenceLookup(text)) savedSentenceHashes.add(sentenceLookupHash(text));
  }

  const hashes = new Set<string>();
  const addCard = (card: unknown) => {
    const { examples } = fieldsOf(card);
    for (const example of Array.isArray(examples) ? examples : []) {
      if (typeof example !== 'string' || !normalizeSentenceLookup(example)) continue;
      const lookupHash = sentenceLookupHash(example);
      if (!savedSentenceHashes.has(lookupHash)) hashes.add(lookupHash);
    }
  };

  for (const item of items) {
    if (item?.isDeleted) continue;
    if (item?.type === 'vocab') addCard(item.data);
    const { vocabs } = fieldsOf(item?.data);
    if (item?.type === 'phrase' && Array.isArray(vocabs)) {
      for (const vocab of vocabs) addCard(vocab);
    }
  }
  return [...hashes].sort((left, right) => left.localeCompare(right));
}

/**
 * How far the examples these items expect are enriched. `stored` must hold the flags of every one of those examples
 * that has a row: read it with readStoredExampleCoverage over these items' expected hashes, or a superset of them.
 */
export function summarizeExampleEnrichmentCoverage(
  items: readonly AuditedItem[],
  stored: StoredExampleCoverage,
): ExampleEnrichmentCoverage {
  const missingAnalysisIds: string[] = [];
  const incompleteDetailedAnalysisIds: string[] = [];
  const missingImageIds: string[] = [];
  let completeDetailedAnalysis = 0;
  let withImage = 0;
  let fullyEnriched = 0;
  const expectedHashes = collectExpectedExampleSentenceHashes(items);

  for (const lookupHash of expectedHashes) {
    const id = exampleSentenceId(lookupHash);
    const coverage = stored.get(lookupHash) || 0;
    const hasRecord = (coverage & 1) !== 0;
    const analysisComplete = (coverage & 2) !== 0;
    const hasImage = (coverage & 4) !== 0;
    if (!hasRecord) {
      missingAnalysisIds.push(id);
    } else {
      if (analysisComplete) completeDetailedAnalysis++;
      else incompleteDetailedAnalysisIds.push(id);
    }

    if (hasImage) withImage++;
    else missingImageIds.push(id);
    if (analysisComplete && hasImage) fullyEnriched++;
  }

  return {
    expected: expectedHashes.length,
    fullyEnriched,
    completeDetailedAnalysis,
    missingAnalysis: missingAnalysisIds.length,
    incompleteDetailedAnalysis: incompleteDetailedAnalysisIds.length,
    withImage,
    missingImage: missingImageIds.length,
    missingAnalysisIds: sample(missingAnalysisIds),
    incompleteDetailedAnalysisIds: sample(incompleteDetailedAnalysisIds),
    missingImageIds: sample(missingImageIds),
  };
}
