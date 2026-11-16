import { useEffect, type RefObject } from 'react';
import { useLatest } from '../../hooks/useStableValue';
import { isDialogOpenOutside, isImeKey, isTypingTarget } from '../../components/keyboardTarget';
import { handleWordKey, type WordKeyHandlers } from './cardKeys';
import { isBareSpace } from './useSentenceShortcuts';

interface WordShortcutsOptions extends WordKeyHandlers {
  enabled: boolean;
  /** The view's root, to tell a dialog over it from one inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Space, when the view decides what it does (the play rule, then the slideshow); otherwise the key table's Space. */
  onSpace?: () => void;
}

/**
 * The word card's letter keys (handleWordKey) while `enabled`, and Space through onSpace when given. The listener is
 * added once and reads the handlers as each key is pressed, so a key acts on the card on screen, also right after a
 * move to another.
 */
export function useWordShortcuts({ enabled, rootRef, ...handlers }: WordShortcutsOptions) {
  const handlersRef = useLatest(handlers);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Typing or composing text isn't a shortcut, and a dialog over the view (a confirm, the shortcut list, a
      // search result) has the keys to itself. The key table ignores held keys.
      if (isTypingTarget(e.target) || isImeKey(e) || isDialogOpenOutside(rootRef.current)) return;
      const { onSpace, ...keyHandlers } = handlersRef.current;
      if (onSpace && isBareSpace(e)) {
        e.preventDefault();
        onSpace();
        return;
      }
      handleWordKey(e, keyHandlers);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, rootRef, handlersRef]);
}
