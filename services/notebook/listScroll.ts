import type { NotebookFilter, NotebookSort } from '../notebookList';

/** What decides where the notebook's list should be scrolled. */
export interface ListScrollInputs {
  /** The query in the box, trimmed. */
  query: string;
  /**
   * The list shows that query: its settled results, or for an empty box the browse list. False while the list
   * still shows what it showed before (it renders a search a moment after the typing, and fuzzy results after a pause).
   */
  settled: boolean;
  sort: NotebookSort;
  filter: NotebookFilter;
  /** Counts the AI lookups started. */
  aiSubmitKey: number;
}

export interface ListScrollAction {
  /** Jump to the top, back to the browse spot a search started from, or nowhere. */
  scroll: 'top' | 'restore' | null;
  /** The browse spot: remember it now, before any jump; keep the one remembered; or forget it. */
  anchor: 'save' | 'keep' | 'drop';
}

/**
 * Where the list goes after its inputs change from `prev` to `next`. A search's results come into view at the top
 * once they settle, and so does the list after a new sort or filter or as an AI lookup starts (where its card will
 * show). The first character typed over the browse list remembers its spot, and the browse list coming back when
 * the box is emptied returns there (if `anchorHeld`), unless the sort or filter changed meanwhile.
 */
export function nextScrollAction(prev: ListScrollInputs, next: ListScrollInputs, anchorHeld: boolean): ListScrollAction {
  if (prev.sort !== next.sort || prev.filter !== next.filter) return { scroll: 'top', anchor: 'drop' };
  const anchor = !prev.query && prev.settled && next.query ? 'save' : 'keep';
  if (prev.aiSubmitKey !== next.aiSubmitKey) return { scroll: 'top', anchor };
  if (next.query) {
    const newlySettled = next.settled && !(prev.settled && prev.query === next.query);
    return { scroll: newlySettled ? 'top' : null, anchor };
  }
  const browseListBack = next.settled && !(prev.settled && !prev.query);
  if (browseListBack) return { scroll: anchorHeld ? 'restore' : null, anchor: 'drop' };
  return { scroll: null, anchor: 'keep' };
}

/**
 * The first row a reader sees: the lowest index among the rendered rows whose bottom edge is below `visibleTop` (the
 * bottom of the sticky header, or the top of the scroller while the header is hidden); null when none is.
 */
export function firstVisibleRowIndex(rows: Iterable<{ index: number; bottom: number }>, visibleTop: number): number | null {
  let first: number | null = null;
  for (const { index, bottom } of rows) {
    if (bottom > visibleTop && Number.isInteger(index) && (first === null || index < first)) first = index;
  }
  return first;
}
