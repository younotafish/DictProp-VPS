import { useCallback, useEffect, useMemo, useState } from 'react';
import { getItemSpelling, type StoredItem } from '../types';
import { sortStoredSensesByUsage } from '../services/usageAudit';
import type { DuplicateClusterView } from '../components/DuplicatesModal';
import { useAnyModalDialogOpen } from '../components/overlayStack';

/** The card popup: the word it shows, by spelling, and the sense it opened on. */
export interface CardPopup { spelling: string; initialId: string }

/** Whether the card popup is open with nothing to show: every sense it showed is gone, deleted here or on another device. */
export const popupIsEmpty = (cardPopup: CardPopup | null, popupItems: readonly StoredItem[]): boolean =>
  cardPopup !== null && popupItems.length === 0;

/**
 * What covers the page. modalOpen: a dialog that asks for a decision or lists something, which keeps every key, the
 * undo shortcut included: App's own (the shortcut sheet, the refused reviews or the duplicates) from the moment it's
 * asked for, while its code may still be loading, or any other dialog on screen, such as UserMenu's sign-out
 * confirmations or an overlay's crash dialog. dialogOpen: one of those, or the card popup showing a card.
 */
export function openDialogs({ cardPopup, popupItems, modalShowing, showKeyboardHelp, showRefusedReviews, duplicateClusters }: {
  cardPopup: CardPopup | null;
  popupItems: readonly StoredItem[];
  /** A dialog (components/Modal) is on screen, wherever it renders (components/overlayStack's useAnyModalDialogOpen). */
  modalShowing: boolean;
  showKeyboardHelp: boolean;
  showRefusedReviews: boolean;
  duplicateClusters: readonly DuplicateClusterView[] | null;
}): { modalOpen: boolean; dialogOpen: boolean } {
  const modalOpen = modalShowing || showKeyboardHelp || showRefusedReviews || duplicateClusters !== null;
  return { modalOpen, dialogOpen: modalOpen || (cardPopup !== null && popupItems.length > 0) };
}

/**
 * Whether the notice stack rises above the card popup (components/AppStatus' liftAbovePopup): the popup is open, a
 * notice the user has to reach over it shows (the undo offer, the couldn't-save alert), and no dialog is open over the
 * popup. A dialog keeps the stack beneath it, and the stack rises again when the dialog closes.
 */
export const liftNoticesAbovePopup = ({ cardPopup, modalOpen, undoOffered, writeFailed }: {
  cardPopup: CardPopup | null;
  modalOpen: boolean;
  undoOffered: boolean;
  writeFailed: boolean;
}): boolean => cardPopup !== null && !modalOpen && (undoOffered || writeFailed);

/**
 * What can open over the page: the card popup, the duplicates dialog, the shortcuts and the refused reviews; and
 * whether any of them, or any other dialog on screen, covers it (openDialogs).
 */
export function useOverlays(libraryWords: StoredItem[]) {
  // The card popup — keyed by the word's SPELLING (so deleting one sense doesn't lose the rest)
  // plus the sense to open on. popupItems = every saved sense of that word, for in-popup paging; it's
  // re-resolved live from libraryWords so Got it / Reset / Delete update the card in place.
  const [cardPopup, setCardPopup] = useState<CardPopup | null>(null);
  const openCardPopup = useCallback((it: StoredItem) => setCardPopup({ spelling: getItemSpelling(it), initialId: it.data.id }), []);
  const popupItems = useMemo(
    () => (cardPopup
      ? sortStoredSensesByUsage(libraryWords.filter(i => i.type === 'vocab' && getItemSpelling(i) === cardPopup.spelling))
      : []),
    [cardPopup, libraryWords],
  );
  const closeCardPopup = useCallback(() => setCardPopup(null), []);
  // Once every sense the popup showed is gone, deleted here or on another device, it closes, rather than staying
  // open with nothing on screen while the page's keys stay off.
  const popupEmpty = popupIsEmpty(cardPopup, popupItems);
  useEffect(() => { if (popupEmpty) setCardPopup(null); }, [popupEmpty]);

  // Phase 2 dedup tool: variant-duplicate clusters under review (null = modal closed).
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateClusterView[] | null>(null);

  // The gestures and shortcuts sheet
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const openKeyboardHelp = useCallback(() => setShowKeyboardHelp(true), []);
  const [showRefusedReviews, setShowRefusedReviews] = useState(false);
  const openRefusedReviews = useCallback(() => setShowRefusedReviews(true), []);

  const modalShowing = useAnyModalDialogOpen();
  const { modalOpen, dialogOpen } = openDialogs({
    cardPopup, popupItems, modalShowing, showKeyboardHelp, showRefusedReviews, duplicateClusters,
  });

  return {
    cardPopup, setCardPopup, openCardPopup, closeCardPopup, popupItems, duplicateClusters, setDuplicateClusters,
    showKeyboardHelp, setShowKeyboardHelp, openKeyboardHelp,
    showRefusedReviews, setShowRefusedReviews, openRefusedReviews, modalOpen, dialogOpen,
  };
}

export type Overlays = ReturnType<typeof useOverlays>;
