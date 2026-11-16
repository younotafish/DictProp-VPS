import { useCallback, useRef, useState } from 'react';
import { getItemTitle, type StoredItem } from '../types';
import { logError } from '../services/logger';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { findInDetailContext, nextDetailKey, type DetailContext, type DetailViewState } from './useDetailView';
import type { Library } from './useLibrary';

/** How long the undo pill stays up. */
const UNDO_OFFER_MS = 6_000;

/**
 * A change the user can take back for a few seconds. The items `ids` stay on this device meanwhile (useLibrary's
 * holdFromPush) and are pushed when the offer closes. `undo` restores each of them if the change still holds, and
 * `onUndo` takes back what isn't an item: an offer for an action holds no ids at all. `view` is the open card view
 * a change to one item took it out of, as it was before, and the version of the view that the change left.
 */
export interface UndoOffer {
  ids: readonly string[];
  message: string;
  undo?: (item: StoredItem) => StoredItem;
  onUndo?: () => void;
  view?: { before: DetailContext; version: number };
}

/** The undo pill's words for a change to one item, '{verb} “{title}”', a sentence's title read without its markers. */
export const undoOfferMessage = (verb: string, item: StoredItem): string => `${verb} “${stripSentenceMarkers(getItemTitle(item))}”`;

/** The undo pill: one offer at a time, which a new offer closes, sending the earlier change on. Every callback is stable. */
export function useUndoOffer(
  { holdFromPush, pushDirtyItems, replaceItem, latestItemsRef, storeItemUpdates }: Pick<Library,
    'holdFromPush' | 'pushDirtyItems' | 'replaceItem' | 'latestItemsRef' | 'storeItemUpdates'>,
  { detailVersionRef, updateDetailContext }: Pick<DetailViewState, 'detailVersionRef' | 'updateDetailContext'>,
) {
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const undoTimerRef = useRef(0);
  // The change on offer.
  const offerRef = useRef<UndoOffer | null>(null);

  /** Ends the undo offer and sends its changes on. */
  const closeUndoOffer = useCallback(() => {
    const offer = offerRef.current;
    if (!offer) return;
    offerRef.current = null;
    holdFromPush(null);
    window.clearTimeout(undoTimerRef.current);
    setUndoMessage(null);
    if (offer.ids.length === 0) return;
    pushDirtyItems(new Set(offer.ids)).catch(error => logError('Push after the undo offer failed', error));
  }, [holdFromPush, pushDirtyItems]);

  /** Offers to take back a change. Call it before that change's push, so its items are held when the push runs. */
  const offerUndoChange = useCallback((offer: UndoOffer) => {
    closeUndoOffer();
    offerRef.current = offer;
    holdFromPush(offer.ids);
    setUndoMessage(offer.message);
    undoTimerRef.current = window.setTimeout(closeUndoOffer, UNDO_OFFER_MS);
  }, [closeUndoOffer, holdFromPush]);

  /** Offers to undo the change just made to `before`'s item, as '{verb} “{title}”'. Call it before that change's push. */
  const offerUndo = useCallback((verb: string, before: StoredItem, undo: (item: StoredItem) => StoredItem, view?: UndoOffer['view']) => {
    offerUndoChange({ ids: [before.data.id], message: undoOfferMessage(verb, before), undo, view });
  }, [offerUndoChange]);

  /** Offers to take back an action that changed no saved item; `onUndo` takes it back. */
  const offerUndoAction = useCallback((message: string, onUndo: () => void) => {
    offerUndoChange({ ids: [], message, onUndo });
  }, [offerUndoChange]);

  const undoLastChange = useCallback(async () => {
    const offer = offerRef.current;
    if (!offer) return;
    const { undo, view } = offer;
    const restored: StoredItem[] = [];
    let movedBack = false;
    if (undo) {
      for (const id of offer.ids) {
        const prior = latestItemsRef.current.find(item => item.data.id === id);
        // Undefined when the item is no longer in the library.
        const copy = replaceItem(id, undo);
        if (!copy) continue;
        restored.push(copy);
        if (copy !== prior) movedBack = true;
      }
    }
    // A single card goes back to its place in the open view it left, or reopens the view it closed, and the view
    // shows it. Not when the view changed meanwhile: it was closed, other cards opened, or another removed.
    if (movedBack && view && offer.ids.length === 1 && view.version === detailVersionRef.current) {
      const position = findInDetailContext(view.before, offer.ids[0]);
      if (position) updateDetailContext({ ...view.before, ...position, navigationKey: nextDetailKey() });
    }
    offer.onUndo?.();
    // Undone, the items usually match the server copies again, so closing the offer finds nothing to push.
    closeUndoOffer();
    if (restored.length > 0) {
      await storeItemUpdates(restored)
        .catch(error => logError('Undo: failed to save the local update', error));
    }
  }, [latestItemsRef, replaceItem, detailVersionRef, updateDetailContext, closeUndoOffer, storeItemUpdates]);

  return { undoMessage, closeUndoOffer, offerUndoChange, offerUndo, offerUndoAction, undoLastChange };
}

export type UndoOfferState = ReturnType<typeof useUndoOffer>;
