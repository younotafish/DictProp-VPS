// The markers the local cycle leaves on what it enriched: an advanced rewrite's, bound to a hash of the card's
// content, and a locally drawn image's, bound to a hash of its prompt. The offline scripts write and check them, and
// the server's audits and importers check the same ones.
//
// Imported by scripts/offline under plain node: no relative imports.
import { createHash } from 'node:crypto';

/** A stored record's fields. Any of them may be missing from a legacy row, or hold the wrong type. */
export type StoredFields = Readonly<Record<string, unknown>>;

/** A value's fields when it is an object, else none, so a missing field and a malformed record read alike. */
export const fieldsOf = (value: unknown): StoredFields =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as StoredFields : {};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as StoredFields;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalize(record[key])]));
}

const isPositiveTime = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The hash an advanced-enrichment marker records: the card's content, without its image and its markers. */
export function advancedVocabContentHash(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const content = Object.fromEntries(Object.entries(data)
    .filter(([key]) => key !== 'imageUrl' && key !== 'advancedEnrichment' && key !== 'localImageEnrichment'));
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

/** The providers whose advanced-enrichment markers count as current: the two local harnesses. */
export const LOCAL_ADVANCED_ENRICHMENT_PROVIDERS: ReadonlySet<unknown> = new Set<unknown>(['codex-harness', 'claude-code']);

/** Whether a card carries an advanced-enrichment marker from a current provider for exactly its present content. */
export function hasCurrentLocalAdvancedEnrichment(data: unknown): boolean {
  const marker = fieldsOf(fieldsOf(data).advancedEnrichment);
  return marker.version === 1 && LOCAL_ADVANCED_ENRICHMENT_PROVIDERS.has(marker.provider) &&
    typeof marker.model === 'string' && marker.model.length > 0 && isPositiveTime(marker.generatedAt) &&
    typeof marker.contentHash === 'string' && marker.contentHash === advancedVocabContentHash(data);
}

export function imagePromptHash(prompt: unknown): string {
  return createHash('sha256').update(String(prompt || '').trim()).digest('hex');
}

/**
 * The provider every locally drawn image's marker names. ERNIE drew the first ones and Krea draws them now, but the
 * value is stored in every marker and checked on import, so it never changes.
 */
export const LOCAL_IMAGE_ENRICHMENT_PROVIDER = 'local-ernie';

/** The marker a locally drawn image leaves on its card. Its key order is part of the card's corpus source hash. */
export const localImageMarker = (model: string, generatedAt: number, promptHash: string) =>
  ({ version: 1, provider: LOCAL_IMAGE_ENRICHMENT_PROVIDER, model, generatedAt, promptHash });

/** Whether a card's locally drawn image was drawn for its present image prompt. */
export function hasCurrentLocalImageEnrichment(data: unknown): boolean {
  const card = fieldsOf(data);
  const marker = fieldsOf(card.localImageEnrichment);
  return marker.version === 1 && marker.provider === LOCAL_IMAGE_ENRICHMENT_PROVIDER &&
    typeof marker.model === 'string' && marker.model.length > 0 && isPositiveTime(marker.generatedAt) &&
    marker.promptHash === imagePromptHash(card.imagePrompt);
}
