import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredItem } from '../../types';
import {
  buildNotebookList, findFuzzyMatches, findLiteralMatches, type NotebookFilter, type NotebookList, type NotebookSort,
} from '../../services/notebookList';
import { useNow } from '../../hooks/useNow';

/** How long typing must pause before a query nothing contains gets its fuzzy scan. */
const FUZZY_PAUSE_MS = 300;

/**
 * The notebook list for the typed query: literal matches at once, fuzzy ones once typing pauses. `clockBump` moves
 * the list's clock on when the notebook says the view changed (a card opened over the list).
 */
export function useNotebookSearch(
  items: StoredItem[], query: string, sortMode: NotebookSort, filterMode: NotebookFilter, clockBump: number,
) {
  // Defer the heavy grouping/search pipeline so typing stays responsive on large libraries: the input
  // updates immediately (query) while the filtered/grouped list catches up a tick behind.
  const deferredSearchQuery = useDeferredValue(query);
  const searchQuery = deferredSearchQuery.trim();
  // A query no word contains, as each keystroke of a word the notebook doesn't have yet is, falls back to a
  // fuzzy scan of every spelling that takes tens of ms. It waits for typing to pause, and until then the
  // list keeps its last results rather than flash empty.
  const [pausedQuery, setPausedQuery] = useState(searchQuery);
  useEffect(() => {
    const timer = window.setTimeout(() => setPausedQuery(searchQuery), FUZZY_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);
  const literalMatches = useMemo(
    () => (searchQuery ? findLiteralMatches(items, searchQuery) : null),
    [items, searchQuery],
  );
  const fuzzyReady = !!searchQuery && !literalMatches && pausedQuery === searchQuery;
  // The time the list counts what's due from (list.now), which its order, its due block, the rows' Due badges and
  // the header's counts share. It's read again only when the view changes: the search or its fuzzy results, the sort
  // or the filter change, a card opens over the list (clockBump), the tab is shown again or the page comes back into view. A
  // sync, an enrichment or an acknowledgement rebuilds the list at the same clock, so rows refresh in place and only
  // a card whose own schedule changed moves; nothing slides into the due block while the list is read.
  const listClockKey = useMemo(
    () => ({ searchQuery, fuzzyReady, sortMode, filterMode, clockBump }),
    [searchQuery, fuzzyReady, sortMode, filterMode, clockBump],
  );
  const now = useNow(listClockKey);
  const shownList = useRef<NotebookList | null>(null);
  const list = useMemo(() => {
    // The list on screen lends the new one its unchanged groups, so their rows don't redraw.
    if (!searchQuery) return buildNotebookList(items, null, sortMode, filterMode, now, shownList.current);
    const matches = literalMatches ?? (fuzzyReady ? findFuzzyMatches(items, searchQuery) : null);
    if (!matches && shownList.current) return shownList.current;
    return buildNotebookList(items, matches ?? [], sortMode, filterMode, now, shownList.current);
  }, [items, searchQuery, literalMatches, fuzzyReady, sortMode, filterMode, now]);
  useEffect(() => { shownList.current = list; }, [list]);
  // The list shows this query's results, not the last query's kept on screen while the fuzzy scan waits.
  const searchSettled = !!searchQuery && (!!literalMatches || fuzzyReady);

  return { searchQuery, list, searchSettled };
}
