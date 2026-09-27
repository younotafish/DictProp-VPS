import { createHash } from 'node:crypto';

export const LOCAL_ADVANCED_ENRICHMENT_VERSION = 1;
export const LOCAL_ADVANCED_ENRICHMENT_PROVIDER = 'codex-harness';
// Cards enriched by either local harness count as current; the marker records which one ran.
export const LOCAL_ADVANCED_ENRICHMENT_PROVIDERS = new Set([LOCAL_ADVANCED_ENRICHMENT_PROVIDER, 'claude-code']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function advancedCardContentHash(card) {
  if (!card || typeof card !== 'object') return '';
  const content = Object.fromEntries(Object.entries(card)
    .filter(([key]) => key !== 'imageUrl' && key !== 'advancedEnrichment' && key !== 'localImageEnrichment'));
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

export function hasCurrentLocalAdvancedEnrichment(card) {
  const marker = card?.advancedEnrichment;
  return marker?.version === LOCAL_ADVANCED_ENRICHMENT_VERSION &&
    LOCAL_ADVANCED_ENRICHMENT_PROVIDERS.has(marker?.provider) &&
    typeof marker.model === 'string' && marker.model.length > 0 &&
    Number.isFinite(marker.generatedAt) && marker.generatedAt > 0 &&
    typeof marker.contentHash === 'string' &&
    marker.contentHash === advancedCardContentHash(card);
}

export function markLocalAdvancedEnrichment(
  card,
  model,
  generatedAt = Date.now(),
  provider = LOCAL_ADVANCED_ENRICHMENT_PROVIDER,
) {
  if (!LOCAL_ADVANCED_ENRICHMENT_PROVIDERS.has(provider)) throw new Error(`Unknown enrichment provider: ${provider}`);
  const withoutMarker = { ...card };
  delete withoutMarker.advancedEnrichment;
  return {
    ...withoutMarker,
    advancedEnrichment: {
      version: LOCAL_ADVANCED_ENRICHMENT_VERSION,
      provider,
      model,
      generatedAt,
      contentHash: advancedCardContentHash(withoutMarker),
    },
  };
}
