import { isSentenceAnalysis, type SentenceAnalysis } from './sentence-analysis.js';
import { isPositiveFinite, isRecord, isSha256, SAFE_IMAGE_PATH } from './validation-helpers.js';

export interface SentenceExportRecord {
  id: string;
  text: string;
  sourceWord: string;
  sourceSense?: string;
  textHash: string;
  hasAnalysis: boolean;
  hasGrammar: boolean;
  hasDetailedAnalysis: boolean;
  hasImage: boolean;
}

export interface SentenceBackfillEntry {
  id: string;
  textHash: string;
  analysis: SentenceAnalysis;
  generatedAt: number;
  imageFile?: string;
  replaceImage?: boolean;
}

export interface SentenceBackfillBundle {
  version: 1;
  generatedAt: number;
  entries: SentenceBackfillEntry[];
}

export function validateSentenceBackfillBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  const bundle = value;
  if (bundle.version !== 1) return 'unsupported bundle version';
  if (!isPositiveFinite(bundle.generatedAt)) return 'bundle generatedAt is invalid';
  if (!Array.isArray(bundle.entries) || bundle.entries.length === 0 || bundle.entries.length > 5_000) {
    return 'bundle entries must contain 1 to 5000 records';
  }
  const ids = new Set<string>();
  for (let index = 0; index < bundle.entries.length; index++) {
    const entry: unknown = bundle.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) return `entry ${index} id is invalid`;
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (!isSha256(entry.textHash)) return `entry ${index} textHash is invalid`;
    if (!isSentenceAnalysis(entry.analysis)) return `entry ${index} analysis is invalid`;
    if (!isPositiveFinite(entry.generatedAt)) return `entry ${index} generatedAt is invalid`;
    if (entry.imageFile !== undefined &&
        (typeof entry.imageFile !== 'string' || !SAFE_IMAGE_PATH.test(entry.imageFile))) {
      return `entry ${index} imageFile is invalid`;
    }
    if (entry.replaceImage !== undefined && typeof entry.replaceImage !== 'boolean') {
      return `entry ${index} replaceImage is invalid`;
    }
    if (entry.replaceImage === true && entry.imageFile === undefined) {
      return `entry ${index} cannot replace an image without imageFile`;
    }
  }
  return null;
}
