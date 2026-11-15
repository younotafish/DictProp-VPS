import { useEffect } from 'react';
import { isKeyboardFocusedControl } from '../../components/keyboardTarget';

/**
 * Enter and Space press a button or link the keyboard focused. The shortcut listeners on window would take
 * those keys for the view (Enter reads from the selected word, Space toggles auto-play) and cancel the
 * press, so they're stopped on the way up. Clicked controls keep the shortcuts (see isKeyboardFocusedControl).
 */
export function usePassKeysToFocusedControl(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const passToFocusedControl = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && isKeyboardFocusedControl(e.target)) e.stopPropagation();
    };
    document.addEventListener('keydown', passToFocusedControl);
    return () => document.removeEventListener('keydown', passToFocusedControl);
  }, [enabled]);
}
