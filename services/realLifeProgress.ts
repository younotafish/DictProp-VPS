import type { SentenceData, StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import {
  findRealLifeSentence,
  type RealLifeCollection,
  type RealLifeSentence,
} from './realLifeCatalog';
import {
  REAL_LIFE_PROGRESS_PREFIX,
  isRealLifeProgressItem,
  realLifeProgressItemId,
} from './realLifeProgressIdentity';
import type { SentenceReviewFilter } from './sentenceOrdering';

export {
  REAL_LIFE_PROGRESS_PREFIX,
  isRealLifeProgressItem,
  realLifeProgressItemId,
} from './realLifeProgressIdentity';

export interface RealLifeCollectionProgress {
  total: number;
  reviewed: number;
  unreviewed: number;
  due: number;
  memorized: number;
  toReview: number;
  masteryScore: number;
}

export function catalogSentenceIdFromProgressItemId(itemId: string): string | null {
  if (!itemId.startsWith(REAL_LIFE_PROGRESS_PREFIX)) return null;
  const catalogSentenceId = itemId.slice(REAL_LIFE_PROGRESS_PREFIX.length);
  return findRealLifeSentence(catalogSentenceId) ? catalogSentenceId : null;
}

export function createRealLifeProgressItem(
  sentence: RealLifeSentence,
  savedAt: number = Date.now(),
): StoredItem {
  const id = realLifeProgressItemId(sentence.id);
  return {
    type: 'sentence',
    data: {
      id,
      text: sentence.markedText,
      sourceWord: sentence.focus,
      sourceSense: sentence.sectionTitle,
      catalogSentenceId: sentence.id,
      catalogCollectionId: sentence.collectionId,
    },
    savedAt,
    srs: SRSAlgorithm.createNew(id, 'sentence'),
  };
}

export function createRealLifeProgressItemFromId(
  itemId: string,
  savedAt: number = Date.now(),
): StoredItem | null {
  const catalogSentenceId = catalogSentenceIdFromProgressItemId(itemId);
  if (!catalogSentenceId) return null;
  const sentence = findRealLifeSentence(catalogSentenceId);
  return sentence ? createRealLifeProgressItem(sentence, savedAt) : null;
}

export function indexRealLifeProgress(items: readonly StoredItem[]): Map<string, StoredItem> {
  const progress = new Map<string, StoredItem>();
  for (const item of items) {
    if (!item.isDeleted && isRealLifeProgressItem(item)) {
      progress.set((item.data as SentenceData).catalogSentenceId!, item);
    }
  }
  return progress;
}

export function buildRealLifeStudyItems(
  sentences: readonly RealLifeSentence[],
  progressItems: readonly StoredItem[],
  savedAt: number = Date.now(),
): StoredItem[] {
  const progress = indexRealLifeProgress(progressItems);
  return sentences.map(sentence => progress.get(sentence.id) ?? createRealLifeProgressItem(sentence, savedAt));
}

export function getRealLifeCollectionProgress(
  collection: RealLifeCollection,
  progressItems: readonly StoredItem[],
  now: number = Date.now(),
): RealLifeCollectionProgress {
  const progress = indexRealLifeProgress(progressItems);
  let reviewed = 0;
  let due = 0;
  let memorized = 0;
  let strength = 0;

  for (const sentence of collection.sentences) {
    const item = progress.get(sentence.id);
    const reviews = item?.srs?.totalReviews ?? 0;
    if (reviews === 0) continue;
    reviewed += 1;
    strength += Math.max(0, Math.min(100, item?.srs?.memoryStrength ?? 0));
    if ((item?.srs?.nextReview ?? 0) <= now) due += 1;
    else memorized += 1;
  }

  const total = collection.sentences.length;
  const unreviewed = total - reviewed;
  return {
    total,
    reviewed,
    unreviewed,
    due,
    memorized,
    toReview: unreviewed + due,
    masteryScore: total === 0 ? 0 : Math.round(strength / total),
  };
}

export function sentenceMatchesRealLifeFilter(
  sentence: RealLifeSentence,
  filter: SentenceReviewFilter,
  progressItems: readonly StoredItem[],
  now: number = Date.now(),
): boolean {
  if (filter === 'all') return true;
  const item = indexRealLifeProgress(progressItems).get(sentence.id);
  const reviews = item?.srs?.totalReviews ?? 0;
  if (filter === 'unreviewed') return reviews === 0;
  if (filter === 'due') return reviews > 0 && (item?.srs?.nextReview ?? 0) <= now;
  return reviews > 0 && (item?.srs?.nextReview ?? 0) > now;
}
