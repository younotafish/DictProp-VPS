/**
 * Keyboard Navigation Hook for Chrome macOS
 * 
 * Provides consistent keyboard shortcuts across the app:
 * - Esc: Close modals, go back
 * - Tab: Navigate focus
 * - Arrow Keys: Navigate carousels, items
 * - Enter/Space: Activate focused element
 * - Cmd+S: Save current item (if applicable)
 * - Cmd+F: Focus search input
 * - 1/2/3: Switch between tabs (Notebook/Sentences/Study) — useGlobalNavigation
 */

import { useEffect, RefObject } from 'react';
import { useLatest } from './useStableValue';

interface KeyboardNavigationOptions {
  onEscape?: () => void;
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onEnter?: () => void;
  onSpace?: () => void;
  onTab?: (shiftKey: boolean) => void;
  onSave?: () => void; // Cmd+S
  onSearch?: () => void; // Cmd+F
  enabled?: boolean;
  // Focus trap for modals
  trapFocus?: boolean;
  containerRef?: RefObject<HTMLElement | null>;
}

export const useKeyboardNavigation = (options: KeyboardNavigationOptions) => {
  const enabled = options.enabled ?? true;
  // Callers pass fresh handlers on most renders; reading them through a ref registers the listener once.
  const optionsRef = useLatest(options);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const {
        onEscape,
        onArrowLeft,
        onArrowRight,
        onArrowUp,
        onArrowDown,
        onEnter,
        onSpace,
        onTab,
        onSave,
        onSearch,
        trapFocus = false,
        containerRef,
      } = optionsRef.current;

      // Don't intercept if user is typing in an input/textarea, or picking in a select
      const target = e.target as HTMLElement;
      const isInputElement = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;

      // Cmd+S - Save; never the browser's Save Page dialog, and not while typing
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!isInputElement) onSave?.();
        return;
      }

      // Cmd+F - Focus search (works everywhere)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        onSearch?.();
        return;
      }

      // Skip most handlers when in input fields (except Escape)
      if (isInputElement && e.key !== 'Escape') {
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onEscape?.();
          break;

        case 'ArrowLeft':
          if (!isInputElement && onArrowLeft) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowLeft();
          }
          break;

        case 'ArrowRight':
          if (!isInputElement && onArrowRight) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowRight();
          }
          break;

        case 'ArrowUp':
          if (!isInputElement && onArrowUp) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowUp();
          }
          break;

        case 'ArrowDown':
          if (!isInputElement && onArrowDown) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onArrowDown();
          }
          break;

        case 'Enter':
          if (!isInputElement) {
            e.preventDefault();
            onEnter?.();
          }
          break;

        case ' ':
          if (!isInputElement) {
            e.preventDefault();
            onSpace?.();
          }
          break;

        case 'Tab':
          if (trapFocus && containerRef?.current) {
            handleFocusTrap(e, containerRef.current);
          }
          onTab?.(e.shiftKey);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, optionsRef]);
};

/**
 * Handle focus trap for modal dialogs
 */
function handleFocusTrap(e: KeyboardEvent, container: HTMLElement) {
  const focusableElements = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  
  if (focusableElements.length === 0) return;
  
  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  
  if (e.shiftKey && document.activeElement === firstElement) {
    e.preventDefault();
    lastElement.focus();
  } else if (!e.shiftKey && document.activeElement === lastElement) {
    e.preventDefault();
    firstElement.focus();
  }
}

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
