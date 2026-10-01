import { useCallback, useRef, useState } from 'react';
import { getItemTitle, type StoredItem } from '../types';
import { saveItemUpdates } from '../services/storage';
import { error as logError } from '../services/logger';
import { findInDetailContext, nextDetailKey, type DetailContext, type DetailViewState } from './useDetailView';
import type { Library } from './useLibrary';

/**
 * A delete, archive or reset the user can take back for a few seconds. `undo` restores the item if the change
 * still holds. `view` is the open card view the change took the item out of, as it was before, and the
 * version of the view that the change left.
 */
export interface UndoOffer {
  id: string;
  message: string;
  undo: (item: StoredItem) => StoredItem;
  view?: { before: DetailContext; version: number };
}

export function useUndoOffer(
  { undoOfferRef, pushDirtyItems, replaceItem, latestItemsRef, currentUserIdRef }: Pick<Library,
    'undoOfferRef' | 'pushDirtyItems' | 'replaceItem' | 'latestItemsRef' | 'currentUserIdRef'>,
  { detailVersionRef, updateDetailContext }: Pick<DetailViewState, 'detailVersionRef' | 'updateDetailContext'>,
) {
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const undoTimerRef = useRef(0);

  /** Ends the undo offer and sends its change on. */
  const closeUndoOffer = useCallback(() => {
    const offer = undoOfferRef.current;
    if (!offer) return;
    undoOfferRef.current = null;
    window.clearTimeout(undoTimerRef.current);
    setUndoMessage(null);
    pushDirtyItems(new Set([offer.id])).catch(error => logError('Push after the undo offer failed', error));
  }, [pushDirtyItems]);

  /** Offers to undo the change just made to `before`'s item. Call it before that change's push. */
  const offerUndo = useCallback((verb: string, before: StoredItem, undo: UndoOffer['undo'], view?: UndoOffer['view']) => {
    closeUndoOffer();
    const message = `${verb} “${getItemTitle(before)}”`;
    undoOfferRef.current = { id: before.data.id, message, undo, view };
    setUndoMessage(message);
    undoTimerRef.current = window.setTimeout(closeUndoOffer, 6_000);
  }, [closeUndoOffer]);

  const undoLastChange = useCallback(async () => {
    const offer = undoOfferRef.current;
    if (!offer) return;
    const prior = latestItemsRef.current.find(item => item.data.id === offer.id);
    const restored = replaceItem(offer.id, offer.undo);
    // The card goes back to its place in the open view it left, or reopens the view it closed, and the view
    // shows it. Not when the view changed meanwhile: it was closed, other cards opened, or another removed.
    const view = offer.view;
    if (restored && restored !== prior && view && view.version === detailVersionRef.current) {
      const position = findInDetailContext(view.before, offer.id);
      if (position) updateDetailContext({ ...view.before, ...position, navigationKey: nextDetailKey() });
    }
    // Undone, the item usually matches the server copy again, so closing the offer finds nothing to push.
    closeUndoOffer();
    if (restored) {
      await saveItemUpdates([restored], currentUserIdRef.current)
        .catch(error => logError('Undo: failed to save the local update', error));
    }
  }, [replaceItem, closeUndoOffer, updateDetailContext]);

  return { undoMessage, closeUndoOffer, offerUndo, undoLastChange };
}

export type UndoOfferState = ReturnType<typeof useUndoOffer>;
