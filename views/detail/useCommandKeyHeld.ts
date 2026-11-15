import { useEffect, useState } from 'react';

/** Whether ⌘ is held down (Mac with a keyboard), so the sentence's words can show that ⌘-click looks them up. */
export function useCommandKeyHeld(enabled: boolean) {
  const [isCommandHeld, setIsCommandHeld] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsCommandHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsCommandHeld(false);
    };
    const reset = () => setIsCommandHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
    };
  }, [enabled]);
  return isCommandHeld;
}
