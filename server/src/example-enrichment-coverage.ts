import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { normalizeSentenceLookup, sentenceLookupHash } from './sentence-enrichment.js';

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
const enrichmentId = (lookupHash: string): string => `example-${lookupHash.slice(0, 40)}`;

export function collectExpectedExampleSentenceHashes(items: any[]): string[] {
  const savedSentenceHashes = new Set<string>();
  for (const item of items) {
    if (item?.isDeleted || item?.type !== 'sentence') continue;
    const text = typeof item.data?.text === 'string' ? item.data.text : '';
    if (normalizeSentenceLookup(text)) savedSentenceHashes.add(sentenceLookupHash(text));
  }

  const hashes = new Set<string>();
  const addCard = (card: any) => {
    for (const example of Array.isArray(card?.examples) ? card.examples : []) {
      if (typeof example !== 'string' || !normalizeSentenceLookup(example)) continue;
      const lookupHash = sentenceLookupHash(example);
      // A saved sentence owns its analysis and image directly, so it does not also need a shared
      // example-enrichment row.
      if (!savedSentenceHashes.has(lookupHash)) hashes.add(lookupHash);
    }
  };

  for (const item of items) {
    if (item?.isDeleted) continue;
    if (item?.type === 'vocab') addCard(item.data);
    if (item?.type === 'phrase' && Array.isArray(item.data?.vocabs)) {
      for (const vocab of item.data.vocabs) addCard(vocab);
    }
  }
  return [...hashes].sort();
}

export function summarizeExampleEnrichmentCoverage(
  items: any[],
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
    const id = enrichmentId(lookupHash);
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
