import type { ItemWrite, ReviewEvent } from './db.js';
import { LOCAL_IMAGE_ENRICHMENT_PROVIDER } from './local-enrichment-markers.js';
import { isSentenceAnalysis } from './sentence-analysis.js';
import { practiceFieldsValid } from './shared/practice.js';
import { isRatingAllowedForTask, isReviewRating, isReviewTaskType } from './shared/review.js';
import { isUsageAudit } from './shared/usage-audit.js';
import {
  isFiniteNonNegative,
  isItemType,
  isPositiveFinite,
  isRecord,
  isSha256,
  type ItemType,
} from './validation-helpers.js';

/** The longest id the API accepts for an item, a review event or a review session. */
export const MAX_ID_LENGTH = 200;

export const isItemId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

const MAX_REVIEW_DURATION_MS = 86_400_000;

/** A review event as a client sends it to /api/reviews/apply, or null when any field is out of bounds. */
export function parseReviewEvent(value: unknown): ReviewEvent | null {
  if (!isRecord(value) || !isItemId(value.id) || !isItemId(value.itemId) || !isItemType(value.itemType)) return null;
  const { reviewedAt, previousStep, nextStep, rating, taskType, durationMs, sessionId } = value;
  if (typeof reviewedAt !== 'number' || !Number.isFinite(reviewedAt) || reviewedAt < 0) return null;
  if (!Number.isInteger(previousStep) || (previousStep as number) < 0) return null;
  if (!Number.isInteger(nextStep) || (nextStep as number) < 0) return null;
  if (rating !== undefined && !isReviewRating(rating)) return null;
  if (taskType !== undefined && !isReviewTaskType(taskType)) return null;
  // Today's task types each take only the ratings their buttons give, so a review that pairs one with another rating
  // is refused rather than scheduled as something the learner never chose.
  if (!isRatingAllowedForTask(taskType, rating)) return null;
  if (durationMs !== undefined &&
      (!Number.isInteger(durationMs) || (durationMs as number) < 0 || (durationMs as number) > MAX_REVIEW_DURATION_MS)) {
    return null;
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > MAX_ID_LENGTH)) return null;
  return {
    id: value.id,
    itemId: value.itemId,
    itemType: value.itemType,
    reviewedAt,
    previousStep: previousStep as number,
    nextStep: nextStep as number,
    ...(rating !== undefined ? { rating } : {}),
    ...(taskType !== undefined ? { taskType } : {}),
    ...(durationMs !== undefined ? { durationMs: durationMs as number } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
// The largest real item is a phrase of about 40 KB. Rows are read whole on every sync page.
const MAX_ITEM_DATA_BYTES = 256 * 1024;
const MAX_NESTING = 32;

/** An advanced-enrichment marker as validation accepts one: a known provider, a model, a time and a content hash. */
export function isAdvancedEnrichmentMarker(value: unknown): boolean {
  return isRecord(value) && value.version === 1 &&
    (value.provider === 'codex-harness' || value.provider === 'claude-code' || value.provider === 'local-mlx') &&
    typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 300 &&
    isPositiveFinite(value.generatedAt) && isSha256(value.contentHash);
}

function isLocalImageEnrichmentMarker(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && value.provider === LOCAL_IMAGE_ENRICHMENT_PROVIDER &&
    typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 300 &&
    isPositiveFinite(value.generatedAt) && isSha256(value.promptHash);
}

/** The SRS counters a stored item must carry, each a finite, non-negative number. */
export const REQUIRED_SRS_FIELDS = [
  'nextReview', 'interval', 'memoryStrength', 'lastReviewDate', 'totalReviews', 'correctStreak', 'stability',
] as const;

/** 'nested' when the value is too deep to walk, true when a string in it holds an inline image. */
function containsInlineImage(value: unknown, depth = 0): boolean | 'nested' {
  if (typeof value === 'string') return /data:image\//i.test(value);
  if (!value || typeof value !== 'object') return false;
  if (depth >= MAX_NESTING) return 'nested';
  for (const child of Object.values(value)) {
    const found = containsInlineImage(child, depth + 1);
    if (found) return found;
  }
  return false;
}

/**
 * Only imageUrl, on the item or on a phrase vocab, may carry an inline image: the server moves those into
 * image storage on write. Anywhere else the bytes would stay in the row and ride along with every sync.
 */
function validateItemDataShape(data: Record<string, unknown>, srs: unknown): string | null {
  const { imageUrl: _imageUrl, ...stored } = data;
  if (Array.isArray(data.vocabs)) {
    stored.vocabs = data.vocabs.map((vocab: unknown) => {
      if (!isRecord(vocab)) return vocab;
      const { imageUrl: _vocabImageUrl, ...rest } = vocab;
      return rest;
    });
  }
  const found = containsInlineImage([stored, srs]);
  if (found === 'nested') return 'item is nested too deeply';
  if (found) return 'item has an inline image outside imageUrl';
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > MAX_ITEM_DATA_BYTES) {
    return `item.data exceeds ${MAX_ITEM_DATA_BYTES / 1024} KB`;
  }
  return null;
}

export function validateStoredItem(value: unknown): string | null {
  if (!isRecord(value)) return 'item must be an object';
  if (!isItemType(value.type)) return 'item.type is invalid';
  if (!isRecord(value.data)) return 'item.data must be an object';
  if (typeof value.data.id !== 'string' || value.data.id.length === 0 || value.data.id.length > MAX_ID_LENGTH) {
    return 'item.data.id is invalid';
  }
  const shapeError = validateItemDataShape(value.data, value.srs);
  if (shapeError) return shapeError;
  if (!isRecord(value.srs)) return 'item.srs must be an object';
  if (value.srs.id !== value.data.id || value.srs.type !== value.type) return 'item.srs identity does not match item.data';
  for (const field of REQUIRED_SRS_FIELDS) {
    if (!isFiniteNonNegative(value.srs[field])) return `item.srs.${field} is invalid`;
  }
  if (!practiceFieldsValid(value.srs)) return 'item.srs practice membership is invalid';
  if (value.srs.lastExposureDate !== undefined && !isFiniteNonNegative(value.srs.lastExposureDate)) {
    return 'item.srs.lastExposureDate is invalid';
  }
  if (!isFiniteNonNegative(value.savedAt)) return 'item.savedAt is invalid';
  if (value.updatedAt !== undefined && !isFiniteNonNegative(value.updatedAt)) return 'item.updatedAt is invalid';
  if (value.serverRevision !== undefined &&
      (typeof value.serverRevision !== 'number' || !Number.isSafeInteger(value.serverRevision) || value.serverRevision < 0)) {
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
  // A phrase's vocabs are an array: checked above.
  if (value.type === 'phrase' && Array.isArray(value.data.vocabs)) {
    for (let index = 0; index < value.data.vocabs.length; index++) {
      const vocab: unknown = value.data.vocabs[index];
      if (!isRecord(vocab)) continue;
      if (vocab.advancedEnrichment !== undefined && !isAdvancedEnrichmentMarker(vocab.advancedEnrichment)) {
        return `phrase vocab ${index} advancedEnrichment is invalid`;
      }
      if (vocab.localImageEnrichment !== undefined && !isLocalImageEnrichmentMarker(vocab.localImageEnrichment)) {
        return `phrase vocab ${index} localImageEnrichment is invalid`;
      }
      if (vocab.usageAudit !== undefined && !isUsageAudit(vocab.usageAudit)) {
        return `phrase vocab ${index} usageAudit is invalid`;
      }
    }
  }
  return null;
}

/** An item validateStoredItem accepted: a known type, JSON-object data and schedule, and an id in data.id. */
export type ValidStoredItem = ItemWrite & {
  type: ItemType;
  data: Record<string, unknown> & { id: string };
  srs: Record<string, unknown>;
};

/** The item, typed as what validateStoredItem accepted, or why it was refused. */
export function checkStoredItem(value: unknown): { item: ValidStoredItem } | { error: string } {
  const error = validateStoredItem(value);
  // validateStoredItem checks every part of this type.
  return error ? { error } : { item: value as ValidStoredItem };
}

/** A request's batch of items, each checked by validateStoredItem, or why the batch was refused. */
export function checkStoredItemBatch(value: unknown, maxItems: number): { items: ValidStoredItem[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'Expected array of items' };
  if (value.length === 0) return { error: 'At least one item is required' };
  if (value.length > maxItems) return { error: `At most ${maxItems} items are allowed per request` };
  for (let index = 0; index < value.length; index++) {
    const error = validateStoredItem(value[index]);
    if (error) return { error: `Invalid item at index ${index}: ${error}` };
  }
  // validateStoredItem accepted every one.
  return { items: value as ValidStoredItem[] };
}
