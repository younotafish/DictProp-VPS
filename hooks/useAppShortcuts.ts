import { useEffect } from 'react';
import type { ViewState } from '../types';
import { isDialogOpenOutside, isTypingTarget } from '../components/keyboardTarget';
import { isMacKeyboard, isUndoShortcut } from '../services/undoRules';
import type { DetailViewState } from './useDetailView';
import type { Overlays } from './useOverlays';
import type { UndoOfferState } from './useUndoOffer';

/** The tab each number key opens. */
const TAB_KEYS: ReadonlyMap<string, ViewState> = new Map([['1', 'notebook'], ['2', 'sentences'], ['3', 'study']]);

/**
 * The app-wide keys: 1, 2 and 3 switch tabs, Escape closes what's on top, ? lists the shortcuts, and ⌘Z (Ctrl+Z
 * off a Mac) takes back what the undo pill offers. The card view's own keys are in useKeyboardNavigation, which only
 * the card view loads.
 */
export function useAppShortcuts(
  navigate: (view: ViewState) => void,
  { detailContext, updateDetailContext }: Pick<DetailViewState, 'detailContext' | 'updateDetailContext'>,
  { cardPopup, setCardPopup, confirmModal, setConfirmModal, showKeyboardHelp, setShowKeyboardHelp, dialogOpen }: Pick<Overlays,
    'cardPopup' | 'setCardPopup' | 'confirmModal' | 'setConfirmModal' | 'showKeyboardHelp' | 'setShowKeyboardHelp' | 'dialogOpen'>,
  { undoMessage, undoLastChange, modalOpen }: Pick<UndoOfferState, 'undoMessage' | 'undoLastChange'> & Pick<Overlays, 'modalOpen'>,
) {
  // 1, 2 and 3 switch tabs, while nothing covers them.
  const tabKeysEnabled = !detailContext && !dialogOpen;
  useEffect(() => {
    if (!tabKeysEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A focused screen (a study session grading with 1-4) may already have used the key.
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      // Only number keys without modifiers
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const view = TAB_KEYS.get(e.key);
      if (!view) return;
      // A dialog over the page, such as the search results, keeps the keyboard.
      if (isDialogOpenOutside(null)) return;
      e.preventDefault();
      navigate(view);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabKeysEnabled, navigate]);

  // ⌘Z takes back the change on offer, except in a text field, where the field's own undo wins, and while a dialog
  // that asks for a decision has the keys.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!isUndoShortcut(e, { typing: isTypingTarget(e.target), undoOpen: undoMessage !== null, isMac: isMacKeyboard(), modalOpen })) return;
      e.preventDefault();
      void undoLastChange();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undoMessage, undoLastChange, modalOpen]);

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
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setShowKeyboardHelp(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [detailContext, confirmModal, showKeyboardHelp, cardPopup, updateDetailContext]);
}
