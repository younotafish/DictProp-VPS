import { fieldsOf, type AuditedItem } from './incremental-enrichment.js';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { exampleSentenceId, normalizeSentenceLookup, sentenceLookupHash } from './sentence-lookup.js';

export interface StoredSentenceEnrichmentRecord {
  lookup_hash: string;
  analysis: string;
  image_content_hash: string | null;
}

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
/** The id of an example's enrichment: exampleSentenceId, under the name the tests import. */
export const enrichmentId = exampleSentenceId;

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

export function summarizeExampleEnrichmentCoverage(
  items: readonly AuditedItem[],
  storedRecords: Iterable<StoredSentenceEnrichmentRecord>,
): ExampleEnrichmentCoverage {
  const missingAnalysisIds: string[] = [];
  const incompleteDetailedAnalysisIds: string[] = [];
  const missingImageIds: string[] = [];
  let completeDetailedAnalysis = 0;
  let withImage = 0;
  let fullyEnriched = 0;
  const expectedHashes = collectExpectedExampleSentenceHashes(items);
  // Bit flags keep this bounded even when each stored analysis is several kilobytes:
  // 1 = row exists, 2 = detailed analysis is complete, 4 = image reference exists.
  const coverageByHash = new Map(expectedHashes.map(hash => [hash, 0]));
  for (const record of storedRecords) {
    if (!coverageByHash.has(record.lookup_hash)) continue;
    let analysisComplete = false;
    try {
      analysisComplete = hasCompleteSentenceAnalysis(JSON.parse(record.analysis));
    } catch {
      analysisComplete = false;
    }
    coverageByHash.set(
      record.lookup_hash,
      1 | (analysisComplete ? 2 : 0) | (record.image_content_hash ? 4 : 0),
    );
  }

  for (const lookupHash of expectedHashes) {
    const id = exampleSentenceId(lookupHash);
    const coverage = coverageByHash.get(lookupHash) || 0;
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
