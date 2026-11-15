import type { StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import type { EssaySentence } from './essayCatalog';
import { catalogProgressItemId } from './catalogProgressIdentity';
import { catalogStudyItems, indexCatalogProgress, type CatalogProgressIndex } from './catalogProgress';

/** A new progress record for an essay sentence, as it stands before its first review. */
export function createEssayProgressItem(
  sentence: EssaySentence,
  savedAt: number = Date.now(),
): StoredItem {
  const id = catalogProgressItemId('essay', sentence.id);
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

export function indexEssayProgress(items: readonly StoredItem[]): CatalogProgressIndex {
  return indexCatalogProgress(items, 'essay');
}

/** The items a run over essay sentences opens; a sentence never stored gets a new record saved at `savedAt`. */
export function buildEssayStudyItems(
  sentences: readonly EssaySentence[],
  index: CatalogProgressIndex,
  savedAt: number = Date.now(),
): StoredItem[] {
  return catalogStudyItems(sentences, index, sentence => createEssayProgressItem(sentence, savedAt));
}
