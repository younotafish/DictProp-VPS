import { useEffect } from 'react';
import { useLatest } from './useStableValue';

// Apart from the view shortcuts in useKeyboardNavigation, which only the card view loads.
/**
 * Hook for global tab navigation (1, 2, 3 to switch tabs)
 */
interface GlobalNavigationOptions {
  onNavigateToNotebook?: () => void;
  onNavigateToSentences?: () => void;
  onNavigateToStudy?: () => void;
  enabled?: boolean;
}

export const useGlobalNavigation = (options: GlobalNavigationOptions) => {
  const enabled = options.enabled ?? true;
  const optionsRef = useLatest(options);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A focused screen (a study session grading with 1-4) may already have used the key.
      if (e.defaultPrevented) return;
      // Don't intercept if user is typing
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) {
        return;
      }

      // Only respond to number keys without modifiers
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '1' && e.key !== '2' && e.key !== '3') return;
      // A dialog over the page, such as the search results, keeps the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;

      const { onNavigateToNotebook, onNavigateToSentences, onNavigateToStudy } = optionsRef.current;
      switch (e.key) {
        case '1':
          e.preventDefault();
          onNavigateToNotebook?.();
          break;
        case '2':
          e.preventDefault();
          onNavigateToSentences?.();
          break;
        case '3':
          e.preventDefault();
          onNavigateToStudy?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, optionsRef]);
};
