import { parseJson, type StorageLike } from '../browserStorage';
import type { NotebookFilter, NotebookSort } from '../notebookList';

/** The notebook's sort and filter, kept on this device across relaunches, like the open tab (not per account). */
export interface NotebookListView {
  sort: NotebookSort;
  filter: NotebookFilter;
}

// A new key rather than 'notebook_sort_mode' and 'notebook_filter_mode', which f250b65 wrote and 882be2f stopped
// reading: a choice left there ten months ago shouldn't come back with this deploy.
const KEY = 'notebook_view_v1';

/** Review priority, words only: the notebook's view before anything is kept. */
export const DEFAULT_NOTEBOOK_LIST_VIEW: Readonly<NotebookListView> = { sort: 'familiarity', filter: 'vocab' };

const SORTS: readonly unknown[] = ['familiarity', 'alphabetical'] satisfies NotebookSort[];
const FILTERS: readonly unknown[] = ['all', 'vocab', 'phrase'] satisfies NotebookFilter[];

// Both take the device's localStorage when given no storage (null means none), and look it up inside their try: a
// browser that blocks storage throws on the lookup itself.

/**
 * The kept sort and filter. A missing, damaged or unknown value falls back to the default, each field on its own,
 * and storage that can't be read reads as nothing kept: this never throws.
 */
export function readNotebookListView(storage?: Pick<StorageLike, 'getItem'> | null): NotebookListView {
  let stored: unknown = null;
  try {
    stored = parseJson((storage === undefined ? globalThis.localStorage : storage)?.getItem(KEY) ?? null);
  } catch {
    // Storage the browser won't let us read keeps nothing.
  }
  const { sort, filter } = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>;
  return {
    sort: SORTS.includes(sort) ? sort as NotebookSort : DEFAULT_NOTEBOOK_LIST_VIEW.sort,
    filter: FILTERS.includes(filter) ? filter as NotebookFilter : DEFAULT_NOTEBOOK_LIST_VIEW.filter,
  };
}

/** Keeps the sort and filter; storage that is full or unavailable just doesn't keep them. */
export function writeNotebookListView(view: NotebookListView, storage?: Pick<StorageLike, 'setItem'> | null): void {
  try {
    (storage === undefined ? globalThis.localStorage : storage)?.setItem(KEY, JSON.stringify({ sort: view.sort, filter: view.filter }));
  } catch {
    // Over quota, or storage the browser won't let us write.
  }
}
