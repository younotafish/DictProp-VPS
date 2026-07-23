import { createHash } from 'crypto';
import { isSentenceAnalysis, type SentenceAnalysis } from './sentence-analysis.js';

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

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IMAGE_PATH = /^images\/[A-Za-z0-9._-]+\.(?:avif|jpe?g|png|webp)$/i;

export function normalizeSentenceLookup(value: string): string {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentenceLookupHash(value: string): string {
  return createHash('sha256').update(normalizeSentenceLookup(value)).digest('hex');
}

export function validateSentenceEnrichmentBundle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'bundle must be an object';
  const bundle = value as Record<string, any>;
  if (bundle.version !== 1) return 'unsupported bundle version';
  if (typeof bundle.generatedAt !== 'number' || !Number.isFinite(bundle.generatedAt) || bundle.generatedAt <= 0) {
    return 'bundle generatedAt is invalid';
  }
  if (!Array.isArray(bundle.entries) || bundle.entries.length === 0) {
    return 'bundle entries must contain records';
  }
  const hasImages = bundle.entries.some((entry: any) => entry?.imageFile !== undefined);
  const maxEntries = hasImages ? 500 : 2_000;
  if (bundle.entries.length > maxEntries) {
    return `bundle entries must contain at most ${maxEntries} records`;
  }

  const ids = new Set<string>();
  const lookupHashes = new Set<string>();
  for (let index = 0; index < bundle.entries.length; index++) {
    const entry = bundle.entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) {
      return `entry ${index} id is invalid`;
    }
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (typeof entry.text !== 'string' || entry.text.length === 0 || entry.text.length > 20_000) {
      return `entry ${index} text is invalid`;
    }
    if (typeof entry.lookupHash !== 'string' || !SHA256.test(entry.lookupHash)) {
      return `entry ${index} lookupHash is invalid`;
    }
    if (lookupHashes.has(entry.lookupHash)) return `entry ${index} duplicates lookupHash ${entry.lookupHash}`;
    lookupHashes.add(entry.lookupHash);
    if (entry.lookupHash !== sentenceLookupHash(entry.text)) return `entry ${index} lookupHash does not match text`;
    if (entry.id !== `example-${entry.lookupHash.slice(0, 40)}`) return `entry ${index} id does not match lookupHash`;
    if (typeof entry.textHash !== 'string' || !SHA256.test(entry.textHash) ||
        entry.textHash !== createHash('sha256').update(entry.text).digest('hex')) {
      return `entry ${index} textHash is invalid`;
    }
    if (!isSentenceAnalysis(entry.analysis)) return `entry ${index} analysis is invalid`;
    if (typeof entry.generatedAt !== 'number' || !Number.isFinite(entry.generatedAt) || entry.generatedAt <= 0) {
      return `entry ${index} generatedAt is invalid`;
    }
    if (entry.imageFile !== undefined &&
        (typeof entry.imageFile !== 'string' || !SAFE_IMAGE_PATH.test(entry.imageFile))) {
      return `entry ${index} imageFile is invalid`;
    }
  }
  return null;
}
