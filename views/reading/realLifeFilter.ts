import type { CatalogProgressIndex } from '../../services/catalogProgress';
import type { RealLifeSentence } from '../../services/realLifeCatalog';
import type { SentenceReviewFilter } from '../../services/sentenceOrdering';
import { matchesReviewFilter } from '../../services/sentenceReviewState';

/** What narrows a collection's list: a theme ('all' or a section id), a review chip and the search box. */
export interface RealLifeListScope {
  sectionId: string;
  reviewFilter: SentenceReviewFilter;
  query: string;
}

/** A collection's lines that match the theme, the review chip and the search, in catalog order. */
export function filterRealLifeSentences(
  sentences: readonly RealLifeSentence[],
  { sectionId, reviewFilter, query }: RealLifeListScope,
  progressIndex: CatalogProgressIndex,
  now: number,
): RealLifeSentence[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
  return sentences.filter(sentence => {
    if (sectionId !== 'all' && sentence.sectionId !== sectionId) return false;
    if (!matchesReviewFilter(progressIndex.get(sentence.id)?.srs, reviewFilter, now)) return false;
    if (!normalizedQuery) return true;
    return `${sentence.text} ${sentence.focus} ${sentence.sectionTitle}`
      .toLocaleLowerCase('en-US')
      .includes(normalizedQuery);
  });
}
