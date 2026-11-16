// The corpus source hash: the hash of an item's data that a corpus export records, that every bundle the local cycle
// publishes carries as its entries' sourceHash, and that the importers compare with the live item's, so an edit made
// after an export is never overwritten.
//
// Imported by scripts/offline under plain node: no relative imports.
import { createHash } from 'node:crypto';

// validation-helpers' isRecord, repeated here so this module has no relative imports.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A JSON value without its imageUrl fields, at any depth: images travel apart from the data. */
export function withoutImageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImageFields(child)]));
}

/**
 * The SHA-256 of an item's data without its images, and without what the server writes into a saved sentence on its
 * own (its analysis, the analysis's timestamp and its speech style), so neither counts as an edit.
 */
export function corpusSourceHash(data: unknown): string {
  const stableData = isRecord(data)
    ? Object.fromEntries(Object.entries(data).filter(([key]) =>
        key !== 'analysis' && key !== 'analysisGeneratedAt' && key !== 'preferredSpeechStyle'))
    : data;
  return createHash('sha256').update(JSON.stringify(withoutImageFields(stableData))).digest('hex');
}
