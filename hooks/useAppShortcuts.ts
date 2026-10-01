import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ViewState } from '../types';
import { useGlobalNavigation } from './useGlobalNavigation';
import type { DetailViewState } from './useDetailView';
import type { Overlays } from './useOverlays';

/** The app-wide keys: 1, 2 and 3 switch tabs, Escape closes what's on top, and ? lists the shortcuts. */
export function useAppShortcuts(
  setCurrentView: Dispatch<SetStateAction<ViewState>>,
  { detailContext, updateDetailContext }: Pick<DetailViewState, 'detailContext' | 'updateDetailContext'>,
  { cardPopup, setCardPopup, confirmModal, setConfirmModal, showKeyboardHelp, setShowKeyboardHelp, duplicateClusters }: Pick<Overlays,
    'cardPopup' | 'setCardPopup' | 'confirmModal' | 'setConfirmModal' | 'showKeyboardHelp' | 'setShowKeyboardHelp' | 'duplicateClusters'>,
) {
  // Global keyboard navigation for tab switching (1, 2, 3 keys)
  useGlobalNavigation({
    onNavigateToNotebook: () => {
      setCurrentView('notebook');
    },
    onNavigateToSentences: () => {
      setCurrentView('sentences');
    },
    onNavigateToStudy: () => {
      setCurrentView('study');
    },
    enabled: !detailContext && !confirmModal && !showKeyboardHelp && !cardPopup && !duplicateClusters, // Disable when modals are open
  });

  // Global Escape key to close modals or go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A layer or view already used this key (Escape that closed a menu).
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (showKeyboardHelp) {
          setShowKeyboardHelp(false);
        } else if (cardPopup) {
          setCardPopup(null);
        } else if (confirmModal) {
          setConfirmModal(null);
        } else if (detailContext) {
          updateDetailContext(null);
        }
      }

      // Cmd+F belongs to GlobalSearch, which opens its search box.

      // ? shows the keyboard shortcuts, except where it is being typed.
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable);
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !typing) {
        e.preventDefault();
        setShowKeyboardHelp(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [detailContext, confirmModal, showKeyboardHelp, cardPopup, updateDetailContext]);
}
