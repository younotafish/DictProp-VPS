import { useCallback, useEffect, useMemo, useState } from 'react';
import { getItemSpelling, type StoredItem } from '../types';
import { sortStoredSensesByUsage } from '../services/usageAudit';
import type { DuplicateClusterView } from '../components/DuplicatesModal';
import type { ConfirmModalProps } from '../components/ConfirmModal';

/** The confirm dialog on screen: ConfirmModal's props, whose Cancel closes it. */
export type ConfirmDialog = Omit<ConfirmModalProps, 'onCancel'>;
/** An acknowledgement: a titled message with one OK button. */
export type Notice = Pick<ConfirmModalProps, 'title' | 'message'> & { variant: NonNullable<ConfirmModalProps['variant']> };
/** The card popup: the word it shows, by spelling, and the sense it opened on. */
export interface CardPopup { spelling: string; initialId: string }

/** Whether the card popup is open with nothing to show: every sense it showed is gone, deleted here or on another device. */
export const popupIsEmpty = (cardPopup: CardPopup | null, popupItems: readonly StoredItem[]): boolean =>
  cardPopup !== null && popupItems.length === 0;

/**
 * What covers the page. modalOpen: a dialog that asks for a decision or lists something (a confirm, the shortcut
 * sheet, the refused reviews or the duplicates), which keeps every key, the undo shortcut included. dialogOpen:
 * one of those, or the card popup showing a card.
 */
export function openDialogs({ cardPopup, popupItems, confirmModal, showKeyboardHelp, showRefusedReviews, duplicateClusters }: {
  cardPopup: CardPopup | null;
  popupItems: readonly StoredItem[];
  confirmModal: ConfirmDialog | null;
  showKeyboardHelp: boolean;
  showRefusedReviews: boolean;
  duplicateClusters: readonly DuplicateClusterView[] | null;
}): { modalOpen: boolean; dialogOpen: boolean } {
  const modalOpen = confirmModal !== null || showKeyboardHelp || showRefusedReviews || duplicateClusters !== null;
  return { modalOpen, dialogOpen: modalOpen || (cardPopup !== null && popupItems.length > 0) };
}

/**
 * What can open over the page: the card popup, the confirm and duplicates dialogs, the shortcuts and the refused
 * reviews, and whether any of them covers it (openDialogs).
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

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<ConfirmDialog | null>(null);
  const showNotice = useCallback((notice: Notice) => {
    setConfirmModal({ ...notice, confirmText: 'OK', onConfirm: () => setConfirmModal(null), showCancel: false });
  }, []);

  // The gestures and shortcuts sheet
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const openKeyboardHelp = useCallback(() => setShowKeyboardHelp(true), []);
  const [showRefusedReviews, setShowRefusedReviews] = useState(false);
  const openRefusedReviews = useCallback(() => setShowRefusedReviews(true), []);

  const { modalOpen, dialogOpen } = openDialogs({ cardPopup, popupItems, confirmModal, showKeyboardHelp, showRefusedReviews, duplicateClusters });

  return {
    cardPopup, setCardPopup, openCardPopup, closeCardPopup, popupItems, duplicateClusters, setDuplicateClusters,
    confirmModal, setConfirmModal, showNotice, showKeyboardHelp, setShowKeyboardHelp, openKeyboardHelp,
    showRefusedReviews, setShowRefusedReviews, openRefusedReviews, modalOpen, dialogOpen,
  };
}

export type Overlays = ReturnType<typeof useOverlays>;
