import type { StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import type { RealLifeSentence } from './realLifeCatalog';
import { catalogProgressItemId } from './catalogProgressIdentity';
import { catalogStudyItems, indexCatalogProgress, type CatalogProgressIndex } from './catalogProgress';

// DetailView still imports this from here. This module reads only the catalog's types, so that import doesn't
// load the catalog; new code imports it from realLifeProgressIdentity.
export { isRealLifeProgressItem } from './realLifeProgressIdentity';

/** A new progress record for a Real Life line, as it stands before its first review. */
export function createRealLifeProgressItem(
  sentence: RealLifeSentence,
  savedAt: number = Date.now(),
): StoredItem {
  const id = catalogProgressItemId('real-life', sentence.id);
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

export function indexRealLifeProgress(items: readonly StoredItem[]): CatalogProgressIndex {
  return indexCatalogProgress(items, 'real-life');
}

/** The items a run over Real Life lines opens; a line never stored gets a new record saved at `savedAt`. */
export function buildRealLifeStudyItems(
  sentences: readonly RealLifeSentence[],
  index: CatalogProgressIndex,
  savedAt: number = Date.now(),
): StoredItem[] {
  return catalogStudyItems(sentences, index, sentence => createRealLifeProgressItem(sentence, savedAt));
}
