import type { SentenceData, StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import { summarizeReviewStates } from './sentenceReviewState';
import type { RealLifeCollection, RealLifeSentence } from './realLifeCatalog';
import { isRealLifeProgressItem, realLifeProgressItemId } from './realLifeProgressIdentity';

// DetailView still imports this from here. This module reads only the catalog's types, so that import doesn't
// load the catalog; new code imports it from realLifeProgressIdentity.
export { isRealLifeProgressItem } from './realLifeProgressIdentity';

export interface RealLifeCollectionProgress {
  total: number;
  reviewed: number;
  unreviewed: number;
  due: number;
  memorized: number;
  toReview: number;
  masteryScore: number;
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
      catalogKind: 'real-life',
      catalogSentenceId: sentence.id,
      catalogCollectionId: sentence.collectionId,
      catalogTitle: sentence.collectionTitle,
    },
    savedAt,
    srs: SRSAlgorithm.createNew(id, 'sentence'),
  };
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
  return summarizeReviewStates(collection.sentences.map(sentence => progress.get(sentence.id)?.srs), now);
}
