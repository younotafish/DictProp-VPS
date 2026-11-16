import { isSentenceAnalysis, type SentenceAnalysis } from './sentence-analysis.js';
import { exampleSentenceId, normalizeSentenceLookup, sentenceLookupHash, sentenceTextHash } from './sentence-lookup.js';
import { isPositiveFinite, isRecord, isSha256, SAFE_IMAGE_PATH } from './validation-helpers.js';

// The key a prepared sentence is stored and looked up by, as sentence-lookup.ts defines it.
export { normalizeSentenceLookup, sentenceLookupHash };

export interface SentenceEnrichmentEntry {
  id: string;
  text: string;
  lookupHash: string;
  textHash: string;
  analysis: SentenceAnalysis;
  generatedAt: number;
  imageFile?: string;
}

export interface SentenceEnrichmentBundle {
  version: 1;
  generatedAt: number;
  entries: SentenceEnrichmentEntry[];
}

export function validateSentenceEnrichmentBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  const bundle = value;
  if (bundle.version !== 1) return 'unsupported bundle version';
  if (!isPositiveFinite(bundle.generatedAt)) return 'bundle generatedAt is invalid';
  if (!Array.isArray(bundle.entries) || bundle.entries.length === 0) {
    return 'bundle entries must contain records';
  }
  const hasImages = bundle.entries.some((entry: unknown) => isRecord(entry) && entry.imageFile !== undefined);
  const maxEntries = hasImages ? 500 : 2_000;
  if (bundle.entries.length > maxEntries) {
    return `bundle entries must contain at most ${maxEntries} records`;
  }

  const ids = new Set<string>();
  const lookupHashes = new Set<string>();
  for (let index = 0; index < bundle.entries.length; index++) {
    const entry: unknown = bundle.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) {
      return `entry ${index} id is invalid`;
    }
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (typeof entry.text !== 'string' || entry.text.length === 0 || entry.text.length > 20_000) {
      return `entry ${index} text is invalid`;
    }
    if (!isSha256(entry.lookupHash)) return `entry ${index} lookupHash is invalid`;
    if (lookupHashes.has(entry.lookupHash)) return `entry ${index} duplicates lookupHash ${entry.lookupHash}`;
    lookupHashes.add(entry.lookupHash);
    if (entry.lookupHash !== sentenceLookupHash(entry.text)) return `entry ${index} lookupHash does not match text`;
    if (entry.id !== exampleSentenceId(entry.lookupHash)) return `entry ${index} id does not match lookupHash`;
    if (!isSha256(entry.textHash) || entry.textHash !== sentenceTextHash(entry.text)) {
      return `entry ${index} textHash is invalid`;
    }
    if (!isSentenceAnalysis(entry.analysis)) return `entry ${index} analysis is invalid`;
    if (!isPositiveFinite(entry.generatedAt)) return `entry ${index} generatedAt is invalid`;
    if (entry.imageFile !== undefined &&
        (typeof entry.imageFile !== 'string' || !SAFE_IMAGE_PATH.test(entry.imageFile))) {
      return `entry ${index} imageFile is invalid`;
    }
  }
  return null;
}
