import { isSentenceAnalysis } from './sentence-analysis.js';
import { isUsageAudit } from './usage-audit.js';

const ITEM_TYPES = new Set(['vocab', 'phrase', 'sentence']);
const MAX_ID_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isAdvancedEnrichmentMarker(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && value.provider === 'local-mlx' &&
    typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 300 &&
    isFiniteNonNegative(value.generatedAt) && value.generatedAt > 0 &&
    typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash);
}

function isLocalImageEnrichmentMarker(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && value.provider === 'local-ernie' &&
    typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 300 &&
    isFiniteNonNegative(value.generatedAt) && value.generatedAt > 0 &&
    typeof value.promptHash === 'string' && /^[a-f0-9]{64}$/.test(value.promptHash);
}

export function validateStoredItem(value: unknown): string | null {
  if (!isRecord(value)) return 'item must be an object';
  if (typeof value.type !== 'string' || !ITEM_TYPES.has(value.type)) return 'item.type is invalid';
  if (!isRecord(value.data)) return 'item.data must be an object';
  if (typeof value.data.id !== 'string' || value.data.id.length === 0 || value.data.id.length > MAX_ID_LENGTH) {
    return 'item.data.id is invalid';
  }
  if (!isRecord(value.srs)) return 'item.srs must be an object';
  if (value.srs.id !== value.data.id || value.srs.type !== value.type) return 'item.srs identity does not match item.data';
  for (const field of ['nextReview', 'interval', 'memoryStrength', 'lastReviewDate', 'totalReviews', 'correctStreak', 'stability']) {
    if (!isFiniteNonNegative(value.srs[field])) return `item.srs.${field} is invalid`;
  }
  if (value.srs.lastExposureDate !== undefined && !isFiniteNonNegative(value.srs.lastExposureDate)) {
    return 'item.srs.lastExposureDate is invalid';
  }
  if (!isFiniteNonNegative(value.savedAt)) return 'item.savedAt is invalid';
  if (value.updatedAt !== undefined && !isFiniteNonNegative(value.updatedAt)) return 'item.updatedAt is invalid';
  if (value.serverRevision !== undefined && (!Number.isSafeInteger(value.serverRevision) || value.serverRevision < 0)) {
    return 'item.serverRevision is invalid';
  }
  if (value.isDeleted !== undefined && typeof value.isDeleted !== 'boolean') return 'item.isDeleted is invalid';
  if (value.isArchived !== undefined && typeof value.isArchived !== 'boolean') return 'item.isArchived is invalid';
  if (value.project !== undefined && (typeof value.project !== 'string' || value.project.length > MAX_ID_LENGTH)) {
    return 'item.project is invalid';
  }

  if (value.type === 'vocab' && (typeof value.data.word !== 'string' || value.data.word.length === 0)) {
    return 'vocab word is required';
  }
  if (value.type === 'vocab' && value.data.advancedEnrichment !== undefined &&
      !isAdvancedEnrichmentMarker(value.data.advancedEnrichment)) {
    return 'vocab advancedEnrichment is invalid';
  }
  if (value.type === 'phrase' && (
    typeof value.data.query !== 'string' || value.data.query.length === 0 || !Array.isArray(value.data.vocabs)
  )) {
    return 'phrase query and vocabs are required';
  }
  if (value.type === 'sentence' && (
    typeof value.data.text !== 'string' || value.data.text.length === 0 || typeof value.data.sourceWord !== 'string'
  )) {
    return 'sentence text and sourceWord are required';
  }
  if (value.type === 'sentence' && value.data.analysis !== undefined && !isSentenceAnalysis(value.data.analysis)) {
    return 'sentence analysis is invalid';
  }
  if (value.type === 'sentence' && value.data.analysisGeneratedAt !== undefined &&
      !isFiniteNonNegative(value.data.analysisGeneratedAt)) {
    return 'sentence analysisGeneratedAt is invalid';
  }
  if (value.type === 'sentence' && value.data.preferredSpeechStyle !== undefined &&
      value.data.preferredSpeechStyle !== 'clear' && value.data.preferredSpeechStyle !== 'casual') {
    return 'sentence preferredSpeechStyle is invalid';
  }
  if (value.data.usageAudit !== undefined && !isUsageAudit(value.data.usageAudit)) {
    return 'item usageAudit is invalid';
  }
  if (value.data.localImageEnrichment !== undefined &&
      !isLocalImageEnrichmentMarker(value.data.localImageEnrichment)) {
    return 'item localImageEnrichment is invalid';
  }
  if (value.type === 'phrase') {
    for (let index = 0; index < value.data.vocabs.length; index++) {
      const vocab = value.data.vocabs[index];
      if (vocab?.advancedEnrichment !== undefined && !isAdvancedEnrichmentMarker(vocab.advancedEnrichment)) {
        return `phrase vocab ${index} advancedEnrichment is invalid`;
      }
      if (vocab?.localImageEnrichment !== undefined &&
          !isLocalImageEnrichmentMarker(vocab.localImageEnrichment)) {
        return `phrase vocab ${index} localImageEnrichment is invalid`;
      }
      if (vocab?.usageAudit !== undefined && !isUsageAudit(vocab.usageAudit)) {
        return `phrase vocab ${index} usageAudit is invalid`;
      }
    }
  }
  return null;
}

export function validateStoredItemBatch(value: unknown, maxItems: number): string | null {
  if (!Array.isArray(value)) return 'Expected array of items';
  if (value.length === 0) return 'At least one item is required';
  if (value.length > maxItems) return `At most ${maxItems} items are allowed per request`;
  for (let index = 0; index < value.length; index++) {
    const error = validateStoredItem(value[index]);
    if (error) return `Invalid item at index ${index}: ${error}`;
  }
  return null;
}
