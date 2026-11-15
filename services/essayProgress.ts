import type { SentenceData, StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import { summarizeReviewStates } from './sentenceReviewState';
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
  return summarizeReviewStates(essay.sentences.map(sentence => progress.get(sentence.id)?.srs), now);
}
