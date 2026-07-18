import { isSentenceAnalysis, type SentenceAnalysis } from './sentence-analysis.js';

export interface SentenceExportRecord {
  id: string;
  text: string;
  sourceWord: string;
  sourceSense?: string;
  textHash: string;
  hasAnalysis: boolean;
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

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IMAGE_PATH = /^images\/[A-Za-z0-9._-]+\.(?:avif|jpe?g|png|webp)$/i;

export function validateSentenceBackfillBundle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'bundle must be an object';
  const bundle = value as Record<string, any>;
  if (bundle.version !== 1) return 'unsupported bundle version';
  if (typeof bundle.generatedAt !== 'number' || !Number.isFinite(bundle.generatedAt) || bundle.generatedAt <= 0) {
    return 'bundle generatedAt is invalid';
  }
  if (!Array.isArray(bundle.entries) || bundle.entries.length === 0 || bundle.entries.length > 5_000) {
    return 'bundle entries must contain 1 to 5000 records';
  }
  const ids = new Set<string>();
  for (let index = 0; index < bundle.entries.length; index++) {
    const entry = bundle.entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) return `entry ${index} id is invalid`;
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (typeof entry.textHash !== 'string' || !SHA256.test(entry.textHash)) return `entry ${index} textHash is invalid`;
    if (!isSentenceAnalysis(entry.analysis)) return `entry ${index} analysis is invalid`;
    if (typeof entry.generatedAt !== 'number' || !Number.isFinite(entry.generatedAt) || entry.generatedAt <= 0) {
      return `entry ${index} generatedAt is invalid`;
    }
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
