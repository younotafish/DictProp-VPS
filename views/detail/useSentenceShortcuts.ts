import { useEffect, type RefObject } from 'react';
import { useLatest } from '../../hooks/useStableValue';
import { acceptKeyRepeat, isDialogOpenOutside, isImeKey, isTypingTarget } from '../../components/keyboardTarget';
import { handleSentenceKey, type SentenceKeyHandlers } from './cardKeys';

interface SentenceShortcutsOptions extends SentenceKeyHandlers {
  enabled: boolean;
  /** The view's root, to tell a dialog over it from one inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Space, when the view decides what it does (auto-play's pause included); otherwise the key table's Space. */
  onSpace?: () => void;
}

/** A Space pressed on its own, once (a held Space acts once, as the key table's keys do). */
export const isBareSpace = (e: Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean =>
  e.key === ' ' && acceptKeyRepeat(e) && !e.metaKey && !e.ctrlKey && !e.altKey;

/**
 * Sentence review's letter keys (handleSentenceKey) while `enabled`, and Space through onSpace when given. The
 * listener is added once and reads the handlers as each key is pressed, so a key acts on the sentence on screen, also
 * right after a move to another.
 */
export function useSentenceShortcuts({ enabled, rootRef, ...handlers }: SentenceShortcutsOptions) {
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
      handleSentenceKey(e, keyHandlers);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, rootRef, handlersRef]);
}
