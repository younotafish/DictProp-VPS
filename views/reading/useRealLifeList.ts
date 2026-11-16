import { useDeferredValue, useMemo, useState } from 'react';
import type { SentenceReviewFilter } from '../../services/sentenceOrdering';
import { useListClock } from '../../hooks/useNow';
import type { RealLifeListScope } from './realLifeFilter';

/**
 * A Real Life collection's list: what narrows it, the theme, the review chip and the search box, each starting on All
 * and empty, and the clock its rows count from. As on the Sentences tab, the clock is taken as the collection opens and
 * again when the theme, the chip or the settled search changes or a sentence opens over the list (useListClock), never
 * when progress arrives from a sync.
 */
export function useRealLifeList() {
  const [sectionId, setSectionId] = useState('all');
  const [reviewFilter, setReviewFilter] = useState<SentenceReviewFilter>('all');
  const [query, setQuery] = useState('');
  // The search the list shows: the box's text once typing lets it through, without the spaces around it, so a
  // trailing space changes neither the list nor the clock.
  const settledQuery = useDeferredValue(query).trim();
  const scope = useMemo<RealLifeListScope>(
    () => ({ sectionId, reviewFilter, query: settledQuery }),
    [sectionId, reviewFilter, settledQuery],
  );
  const { now, noteOpened } = useListClock(scope);
  return { scope, query, setQuery, setSectionId, setReviewFilter, now, noteOpened };
}
