import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredItem } from '../../types';
import {
  buildNotebookList, findFuzzyMatches, findLiteralMatches, type NotebookFilter, type NotebookList, type NotebookSort,
} from '../../services/notebookList';

/** The notebook list for the typed query: literal matches at once, fuzzy ones once typing pauses. */
export function useNotebookSearch(items: StoredItem[], query: string, sortMode: NotebookSort, filterMode: NotebookFilter) {
  // Defer the heavy grouping/search pipeline so typing stays responsive on large libraries: the input
  // updates immediately (query) while the filtered/grouped list catches up a tick behind.
  const deferredSearchQuery = useDeferredValue(query);
  const searchQuery = deferredSearchQuery.trim();
  // A query no word contains, as each keystroke of a word the notebook doesn't have yet is, falls back to a
  // fuzzy scan of every spelling that takes tens of ms. It waits for typing to pause, and until then the
  // list keeps its last results rather than flash empty.
  const [pausedQuery, setPausedQuery] = useState(searchQuery);
  useEffect(() => {
    const timer = window.setTimeout(() => setPausedQuery(searchQuery), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);
  const literalMatches = useMemo(
    () => (searchQuery ? findLiteralMatches(items, searchQuery) : null),
    [items, searchQuery],
  );
  const fuzzyReady = !!searchQuery && !literalMatches && pausedQuery === searchQuery;
  const shownList = useRef<NotebookList | null>(null);
  const list = useMemo(() => {
    if (!searchQuery) return buildNotebookList(items, null, sortMode, filterMode);
    const matches = literalMatches ?? (fuzzyReady ? findFuzzyMatches(items, searchQuery) : null);
    if (!matches && shownList.current) return shownList.current;
    return buildNotebookList(items, matches ?? [], sortMode, filterMode);
  }, [items, searchQuery, literalMatches, fuzzyReady, sortMode, filterMode]);
  useEffect(() => { shownList.current = list; }, [list]);
  // The list shows this query's results, not the last query's kept on screen while the fuzzy scan waits.
  const searchSettled = !!searchQuery && (!!literalMatches || fuzzyReady);

  return { searchQuery, list, searchSettled };
}
