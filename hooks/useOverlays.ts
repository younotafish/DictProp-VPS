import { useCallback, useMemo, useState } from 'react';
import { getItemSpelling, type StoredItem } from '../types';
import { sortStoredSensesByUsage } from '../services/usageAudit';
import type { DuplicateClusterView } from '../components/DuplicatesModal';

/** What can open over the page: the card popup, the confirm and duplicates dialogs, the shortcuts and the refused reviews. */
export function useOverlays(allActiveItems: StoredItem[]) {
  // Footnote card popup — keyed by the word's SPELLING (so deleting one sense doesn't lose the rest)
  // plus the sense to open on. popupItems = every saved sense of that word, for in-popup paging; it's
  // re-resolved live from allActiveItems so Got it / Reset / Delete update the card in place.
  const [cardPopup, setCardPopup] = useState<{ spelling: string; initialId: string } | null>(null);
  const openCardPopup = useCallback((it: StoredItem) => setCardPopup({ spelling: getItemSpelling(it), initialId: it.data.id }), []);
  const popupItems = useMemo(
    () => (cardPopup
      ? sortStoredSensesByUsage(allActiveItems.filter(i => i.type === 'vocab' && getItemSpelling(i) === cardPopup.spelling))
      : []),
    [cardPopup, allActiveItems],
  );
  const closeCardPopup = useCallback(() => setCardPopup(null), []);

  // Phase 2 dedup tool: variant-duplicate clusters under review (null = modal closed).
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateClusterView[] | null>(null);

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'success' | 'info';
    onConfirm: () => void;
    showCancel?: boolean;
  } | null>(null);

  // Keyboard shortcuts help modal
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const openKeyboardHelp = useCallback(() => setShowKeyboardHelp(true), []);
  const [showRefusedReviews, setShowRefusedReviews] = useState(false);
  const openRefusedReviews = useCallback(() => setShowRefusedReviews(true), []);

  return {
    cardPopup, setCardPopup, openCardPopup, closeCardPopup, popupItems, duplicateClusters, setDuplicateClusters,
    confirmModal, setConfirmModal, showKeyboardHelp, setShowKeyboardHelp, openKeyboardHelp,
    showRefusedReviews, setShowRefusedReviews, openRefusedReviews,
  };
}

export type Overlays = ReturnType<typeof useOverlays>;
