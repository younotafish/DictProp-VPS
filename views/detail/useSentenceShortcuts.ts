import { useEffect, type RefObject } from 'react';
import { useLatest } from '../../hooks/useStableValue';
import { isDialogOpenOutside, isImeKey, isTypingTarget } from '../../components/keyboardTarget';
import { handleSentenceKey, type SentenceKeyHandlers } from './cardKeys';

interface SentenceShortcutsOptions extends SentenceKeyHandlers {
  enabled: boolean;
  /** The view's root, to tell a dialog over it from one inside it. */
  rootRef: RefObject<HTMLElement | null>;
}

/**
 * Sentence review's letter keys (handleSentenceKey) while `enabled`. The listener is added once and reads the
 * handlers as each key is pressed, so a key acts on the sentence on screen, also right after a move to another.
 */
export function useSentenceShortcuts({ enabled, rootRef, ...handlers }: SentenceShortcutsOptions) {
  const handlersRef = useLatest(handlers);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Typing or composing text isn't a shortcut, a dialog over the view (a confirm, the shortcut list, a
      // search result) has the keys to itself, and a held key acts once rather than deleting card after card.
      if (isTypingTarget(e.target) || isImeKey(e) || e.repeat || isDialogOpenOutside(rootRef.current)) return;
      handleSentenceKey(e, handlersRef.current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, rootRef, handlersRef]);
}
