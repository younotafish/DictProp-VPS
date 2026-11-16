// The advancedEnrichment marker, which ties a card's advanced rewrite to a hash of its content. The completion stage
// writes it here; what makes one current, and its content hash, are the server's own, from
// server/src/local-enrichment-markers.ts, so the cycle and production's audits judge a card alike.
import {
  advancedVocabContentHash,
  hasCurrentLocalAdvancedEnrichment,
  LOCAL_ADVANCED_ENRICHMENT_PROVIDERS,
} from '../../server/src/local-enrichment-markers.ts';

// Cards enriched by either local harness count as current; the marker records which one ran.
export { hasCurrentLocalAdvancedEnrichment };

const LOCAL_ADVANCED_ENRICHMENT_VERSION = 1;
const LOCAL_ADVANCED_ENRICHMENT_PROVIDER = 'codex-harness';

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
      contentHash: advancedVocabContentHash(withoutMarker),
    },
  };
}
