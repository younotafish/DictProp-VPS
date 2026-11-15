import { createHash } from 'node:crypto';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { hasCompleteGeneratedVocabMetadata, isValidGeneratedExampleSet } from './ai-response.js';

/** A stored record's fields. Any of them may be missing from a legacy row, or hold the wrong type. */
export type StoredFields = Readonly<Record<string, unknown>>;

/** An item as getAllItems returns it, as far as the audits read it. */
export interface AuditedItem {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly savedAt?: unknown;
  readonly updatedAt?: unknown;
  readonly isDeleted?: unknown;
  readonly isArchived?: unknown;
}

/** A value's fields when it is an object, else none, so a missing field and a malformed record read alike. */
export const fieldsOf = (value: unknown): StoredFields =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as StoredFields : {};

// ─── The markers the local cycle leaves on what it enriched ───
// Everything down to the next heading uses only node:crypto, so it can move whole into a module the offline scripts
// load under plain node.

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

const LOCAL_ADVANCED_ENRICHMENT_PROVIDERS = new Set<unknown>(['codex-harness', 'claude-code']);

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

// ─── What the local cycle still owes ───

/**
 * Whether a card has an image on the server. Every stored image reads back as a server:has_image marker; a row saved
 * before imageUrl was stripped on write may still carry a string of its own, and any non-empty string counts.
 */
function hasStoredImage(data: unknown): boolean {
  const { imageUrl } = fieldsOf(data);
  return typeof imageUrl === 'string' && imageUrl.length > 0;
}

export function hasCompleteVocabContent(data: unknown): boolean {
  return hasCompleteGeneratedVocabMetadata(data) && isValidGeneratedExampleSet(fieldsOf(data).examples);
}

const hasImagePrompt = (data: unknown): boolean => {
  const { imagePrompt } = fieldsOf(data);
  return typeof imagePrompt === 'string' && imagePrompt.trim() !== '';
};

/** What the cycle still owes one card: a vocab item's data, or a card in a phrase. */
interface CardGaps {
  /** Recent cards only: generated fields or examples are incomplete. */
  content: boolean;
  /** Recent cards only: no current advanced-enrichment marker. */
  advanced: boolean;
  /** Recent cards only: marked as enriched, with an image prompt but no current locally drawn image. */
  localImage: boolean;
  /** Any card: an image prompt but no stored image. */
  storedImage: boolean;
}

/**
 * A card saved within the lookback owes everything the cycle produces; an older one owes only the stored image its
 * prompt asks for. Each check runs once, so the content hash behind the advanced marker is taken at most once.
 */
function cardGaps(card: unknown, recent: boolean): CardGaps {
  const prompted = hasImagePrompt(card);
  const storedImage = prompted && !hasStoredImage(card);
  if (!recent) return { content: false, advanced: false, localImage: false, storedImage };
  const advanced = hasCurrentLocalAdvancedEnrichment(card);
  return {
    content: !hasCompleteVocabContent(card),
    advanced: !advanced,
    localImage: prompted && advanced && !hasCurrentLocalImageEnrichment(card),
    storedImage,
  };
}

const owesCardWork = (gaps: CardGaps): boolean => gaps.content || gaps.advanced || gaps.localImage || gaps.storedImage;

type ItemGaps =
  | { type: 'sentence'; detailedAnalysis: boolean; image: boolean }
  | { type: 'vocab'; card: CardGaps }
  | { type: 'phrase'; image: boolean; localImage: boolean; cards: CardGaps[] };

/** What the cycle owes an item, or null for one it never works on: deleted, archived, empty or of no known type. */
function itemGaps(item: AuditedItem, recent: boolean): ItemGaps | null {
  if (!item?.data || item.isDeleted || item.isArchived) return null;
  const data = fieldsOf(item.data);
  if (item.type === 'sentence') {
    return { type: 'sentence', detailedAnalysis: !hasCompleteSentenceAnalysis(data.analysis), image: !hasStoredImage(data) };
  }
  if (item.type === 'vocab') return { type: 'vocab', card: cardGaps(item.data, recent) };
  if (item.type === 'phrase') {
    const cards = Array.isArray(data.vocabs) ? data.vocabs.map((card: unknown) => cardGaps(card, recent)) : null;
    const prompted = hasImagePrompt(data);
    // The phrase's own picture is drawn locally once one of its cards has been enriched.
    const hasEnrichedCard = recent && cards !== null && cards.some(gaps => !gaps.advanced);
    return {
      type: 'phrase',
      image: prompted && !hasStoredImage(data),
      localImage: hasEnrichedCard && prompted && !hasCurrentLocalImageEnrichment(data),
      cards: cards ?? [],
    };
  }
  return null;
}

function owesWork(gaps: ItemGaps): boolean {
  if (gaps.type === 'sentence') return gaps.detailedAnalysis || gaps.image;
  if (gaps.type === 'vocab') return owesCardWork(gaps.card);
  return gaps.image || gaps.localImage || gaps.cards.some(owesCardWork);
}

/**
 * The items the local cycle still owes work, and what it owes them. An item saved at or after prioritySince is recent
 * and owes everything; an older one owes only its stored images.
 */
export function summarizeIncrementalEnrichmentBacklog(items: readonly AuditedItem[], prioritySince: number) {
  const summary = {
    items: 0,
    recentItems: 0,
    historicalItems: 0,
    byType: { sentence: 0, vocab: 0, phrase: 0 },
    gaps: {
      sentenceDetailedAnalysis: 0,
      sentenceImage: 0,
      recentVocabContent: 0,
      recentVocabAdvanced: 0,
      recentNestedVocabContent: 0,
      recentNestedVocabAdvanced: 0,
      recentVocabLocalImage: 0,
      recentPhraseLocalImage: 0,
      recentNestedVocabLocalImage: 0,
      vocabImage: 0,
      phraseImage: 0,
      nestedVocabImage: 0,
    },
  };
  const { byType, gaps: counts } = summary;

  for (const item of items) {
    const recent = Number(item?.savedAt) >= prioritySince;
    const gaps = itemGaps(item, recent);
    if (!gaps || !owesWork(gaps)) continue;
    summary.items++;
    if (recent) summary.recentItems++;
    else summary.historicalItems++;

    if (gaps.type === 'sentence') {
      byType.sentence++;
      if (gaps.detailedAnalysis) counts.sentenceDetailedAnalysis++;
      if (gaps.image) counts.sentenceImage++;
    } else if (gaps.type === 'vocab') {
      byType.vocab++;
      if (gaps.card.content) counts.recentVocabContent++;
      if (gaps.card.advanced) counts.recentVocabAdvanced++;
      if (gaps.card.localImage) counts.recentVocabLocalImage++;
      if (gaps.card.storedImage) counts.vocabImage++;
    } else {
      byType.phrase++;
      if (gaps.image) counts.phraseImage++;
      if (gaps.localImage) counts.recentPhraseLocalImage++;
      for (const card of gaps.cards) {
        if (card.content) counts.recentNestedVocabContent++;
        if (card.advanced) counts.recentNestedVocabAdvanced++;
        if (card.localImage) counts.recentNestedVocabLocalImage++;
        if (card.storedImage) counts.nestedVocabImage++;
      }
    }
  }
  return summary;
}
