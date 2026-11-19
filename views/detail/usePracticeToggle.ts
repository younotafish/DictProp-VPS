import { useMemo } from 'react';
import type { StoredItem } from '../../types';
import { useLatest } from '../../hooks/useStableValue';
import { useTimedMessage } from '../../hooks/useTimedMessage';
import { createPracticePress, practiceToggleFor } from './practiceToggle';
import type { DetailViewProps } from './types';

/** How long the reason a press couldn't be taken back shows: as long as Study shows its failed undo. */
const UNDO_FAILURE_MS = 4_000;

interface PracticeToggleOptions {
  /** The library's copy of the sentence on screen; undefined without one (an example's preview). */
  item: StoredItem | undefined;
  onUpdateSRS: DetailViewProps['onUpdateSRS'];
  onUndoReview: DetailViewProps['onUndoReview'];
  onOfferUndo: DetailViewProps['onOfferUndo'];
}

/**
 * The practice pill of the sentence on screen: what it shows (practiceToggleFor, or nothing without the three callbacks
 * it needs), the press the pill and B share (createPracticePress), and why an undo failed, for PracticeNotice. The
 * toggle is worked out again only when the library's copy changes, not on every render of the lesson, and the press is
 * one function for the view's life, reading the latest of everything as it happens.
 */
export function usePracticeToggle({ item, onUpdateSRS, onUndoReview, onOfferUndo }: PracticeToggleOptions) {
  const enabled = !!(onUpdateSRS && onUndoReview && onOfferUndo);
  const toggle = useMemo(() => (enabled ? practiceToggleFor(item) : null), [enabled, item]);
  const latest = useLatest({ toggle, onUpdateSRS, onUndoReview, onOfferUndo });
  const { message: undoFailure, show: showUndoFailure } = useTimedMessage<string>(UNDO_FAILURE_MS);

  // The toggle is null unless all three callbacks are there, so a press never reaches the fallbacks below.
  const press = useMemo(() => createPracticePress({
    toggle: () => latest.current.toggle,
    record: (itemId, rating, context) => latest.current.onUpdateSRS?.(itemId, rating, context),
    undoReview: eventId => latest.current.onUndoReview?.(eventId) ?? Promise.resolve(false),
    offerUndo: (message, undo) => latest.current.onOfferUndo?.(message, undo),
    showUndoFailure,
    now: () => performance.now(),
    createId: () => crypto.randomUUID(),
    isOnline: () => navigator.onLine,
  }), [latest, showUndoFailure]);

  return { toggle, press, undoFailure };
}
