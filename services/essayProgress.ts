import type { SentenceData, StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import type { Essay, EssaySentence } from './essayCatalog';
import { essayProgressItemId, isEssayProgressItem } from './essayProgressIdentity';

export interface EssayProgress {
  total: number;
  reviewed: number;
  unreviewed: number;
  due: number;
  memorized: number;
  toReview: number;
  masteryScore: number;
}

export function createEssayProgressItem(
  sentence: EssaySentence,
  savedAt: number = Date.now(),
): StoredItem {
  const id = essayProgressItemId(sentence.id);
  return {
    type: 'sentence',
    data: {
      id,
      text: sentence.markedText,
      sourceWord: sentence.focus,
      sourceSense: `${sentence.essayTitle} — ${sentence.author}`,
      catalogKind: 'essay',
      catalogSentenceId: sentence.id,
      catalogCollectionId: sentence.essayId,
      catalogTitle: sentence.essayTitle,
    },
    savedAt,
    srs: SRSAlgorithm.createNew(id, 'sentence'),
  };
}

export function indexEssayProgress(items: readonly StoredItem[]): Map<string, StoredItem> {
  const progress = new Map<string, StoredItem>();
  for (const item of items) {
    if (!item.isDeleted && isEssayProgressItem(item)) {
      progress.set((item.data as SentenceData).catalogSentenceId!, item);
    }
  }
  return progress;
}

export function buildEssayStudyItems(
  sentences: readonly EssaySentence[],
  progressItems: readonly StoredItem[],
  savedAt: number = Date.now(),
): StoredItem[] {
  const progress = indexEssayProgress(progressItems);
  return sentences.map(sentence => progress.get(sentence.id) ?? createEssayProgressItem(sentence, savedAt));
}

export function getEssayProgress(
  essay: Essay,
  progressItems: readonly StoredItem[],
  now: number = Date.now(),
): EssayProgress {
  const progress = indexEssayProgress(progressItems);
  let reviewed = 0;
  let due = 0;
  let memorized = 0;
  let strength = 0;

  for (const sentence of essay.sentences) {
    const item = progress.get(sentence.id);
    const reviews = item?.srs?.totalReviews ?? 0;
    if (reviews === 0) continue;
    reviewed += 1;
    strength += Math.max(0, Math.min(100, item?.srs?.memoryStrength ?? 0));
    if ((item?.srs?.nextReview ?? 0) <= now) due += 1;
    else memorized += 1;
  }

  const total = essay.sentences.length;
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
