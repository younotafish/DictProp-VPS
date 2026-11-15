/**
 * The card view's navigation keys: the arrows, Enter and Cmd/Ctrl+S. Space and Cmd/Ctrl+F are kept from the
 * browser here too. The letter shortcuts live with each view (useWordShortcuts, useSentenceShortcuts), Escape goes
 * through the escape stack (useEscapeLayer), and the tab keys 1/2/3 are useGlobalNavigation's.
 */

import { useEffect, RefObject } from 'react';
import { useLatest } from './useStableValue';
import { isTypingTarget } from '../components/keyboardTarget';

interface KeyboardNavigationOptions {
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onEnter?: () => void;
  onSave?: () => void; // Cmd+S
  enabled?: boolean;
}

export const useKeyboardNavigation = (options: KeyboardNavigationOptions) => {
  const enabled = options.enabled ?? true;
  // Callers pass fresh handlers on most renders; reading them through a ref registers the listener once.
  const optionsRef = useLatest(options);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const { onArrowLeft, onArrowRight, onArrowUp, onArrowDown, onEnter, onSave } = optionsRef.current;

      // Don't intercept if user is typing in an input/textarea, or picking in a select
      const isInputElement = isTypingTarget(e.target);

      // Cmd+S - Save; never the browser's Save Page dialog, and not while typing
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!isInputElement) onSave?.();
        return;
      }

      // Cmd+F is the app's search (GlobalSearch takes it), never the browser's Find
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        return;
      }

      // Skip the rest when in input fields (except Escape)
      if (isInputElement && e.key !== 'Escape') {
        return;
      }

      switch (e.key) {
        case 'Escape':
          // The view's escape layer does the closing; this only keeps the browser's default action off.
          e.preventDefault();
          break;

        case 'ArrowLeft':
          if (onArrowLeft) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowLeft();
          }
          break;

        case 'ArrowRight':
          if (onArrowRight) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowRight();
          }
          break;

        case 'ArrowUp':
          if (onArrowUp) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowUp();
          }
          break;

        case 'ArrowDown':
          if (onArrowDown) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowDown();
          }
          break;

        case 'Enter':
          e.preventDefault();
          onEnter?.();
          break;

        case ' ':
          // Space never scrolls the card, including the held repeats the letter shortcuts ignore.
          e.preventDefault();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, optionsRef]);
};

/**
 * Hook for horizontal wheel scrolling (trackpad gestures)
 * Converts horizontal scroll into carousel navigation
 */
interface WheelNavigationOptions {
  onScrollLeft?: () => void;
  onScrollRight?: () => void;
  containerRef: RefObject<HTMLElement | null>;
  threshold?: number;
  enabled?: boolean;
}

// A pause this long between wheel events ends a swipe.
const SWIPE_GAP_MS = 200;
// Once momentum has slowed to this, the rest of it can't travel far enough to navigate again.
const MOMENTUM_SPENT = 4;

export const useWheelNavigation = (options: WheelNavigationOptions) => {
  const { containerRef, threshold = 50, enabled = true } = options;
  const optionsRef = useLatest(options);

  useEffect(() => {
    const element = containerRef.current;
    if (!enabled || !element) return;

    // One navigation per swipe. macOS keeps sending wheel events for the momentum after the fingers
    // lift, so once a swipe has navigated, it's ignored until it pauses or its momentum is spent.
    let accumulatedDelta = 0;
    let navigated = false;
    let lastEventAt = -Infinity;

    const handleWheel = (e: WheelEvent) => {
      // Only handle horizontal scroll (trackpad two-finger swipe)
      const delta = Math.abs(e.deltaX);
      if (delta <= Math.abs(e.deltaY)) return;
      if (e.timeStamp - lastEventAt > SWIPE_GAP_MS || (navigated && delta < MOMENTUM_SPENT)) {
        accumulatedDelta = 0;
        navigated = false;
      }
      lastEventAt = e.timeStamp;
      if (delta <= 5) return;
      e.preventDefault();
      if (navigated) return;

      accumulatedDelta += e.deltaX;
      if (Math.abs(accumulatedDelta) > threshold) {
        navigated = true;
        const { onScrollLeft, onScrollRight } = optionsRef.current;
        if (accumulatedDelta > 0) onScrollRight?.();
        else onScrollLeft?.();
      }
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [enabled, containerRef, threshold, optionsRef]);
};
