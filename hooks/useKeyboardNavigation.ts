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
 * - 1/2: Switch between tabs (Notebook/Study)
 */

import { useEffect, useCallback, RefObject } from 'react';

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
  containerRef?: RefObject<HTMLElement>;
}

export const useKeyboardNavigation = (options: KeyboardNavigationOptions) => {
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
    enabled = true,
    trapFocus = false,
    containerRef,
  } = options;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Don't intercept if user is typing in an input/textarea
    const target = e.target as HTMLElement;
    const isInputElement = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    
    // Cmd+S - Save (works even in input fields)
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      onSave?.();
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
        if (!isInputElement) {
          e.preventDefault();
          onArrowLeft?.();
        }
        break;
      
      case 'ArrowRight':
        if (!isInputElement) {
          e.preventDefault();
          onArrowRight?.();
        }
        break;
      
      case 'ArrowUp':
        if (!isInputElement) {
          e.preventDefault();
          onArrowUp?.();
        }
        break;
      
      case 'ArrowDown':
        if (!isInputElement) {
          e.preventDefault();
          onArrowDown?.();
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
  }, [enabled, onEscape, onArrowLeft, onArrowRight, onArrowUp, onArrowDown, onEnter, onSpace, onTab, onSave, onSearch, trapFocus, containerRef]);

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);
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
 * Hook for global tab navigation (1, 2, 3 to switch tabs)
 */
interface GlobalNavigationOptions {
  onNavigateToNotebook?: () => void;
  onNavigateToStudy?: () => void;
  enabled?: boolean;
}

export const useGlobalNavigation = (options: GlobalNavigationOptions) => {
  const {
    onNavigateToNotebook,
    onNavigateToStudy,
    enabled = true,
  } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Only respond to number keys without modifiers
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case '1':
          e.preventDefault();
          onNavigateToNotebook?.();
          break;
        case '2':
          e.preventDefault();
          onNavigateToStudy?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onNavigateToNotebook, onNavigateToStudy]);
};

/**
 * Hook for horizontal wheel scrolling (trackpad gestures)
 * Converts horizontal scroll into carousel navigation
 */
interface WheelNavigationOptions {
  onScrollLeft?: () => void;
  onScrollRight?: () => void;
  containerRef: RefObject<HTMLElement>;
  threshold?: number;
  enabled?: boolean;
}

export const useWheelNavigation = (options: WheelNavigationOptions) => {
  const {
    onScrollLeft,
    onScrollRight,
    containerRef,
    threshold = 50,
    enabled = true,
  } = options;

  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    let accumulatedDelta = 0;
    let timeoutId: number;

    const handleWheel = (e: WheelEvent) => {
      // Only handle horizontal scroll (trackpad two-finger swipe)
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 5) {
        e.preventDefault();
        
        accumulatedDelta += e.deltaX;
        
        // Clear timeout to reset accumulation
        clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => {
          accumulatedDelta = 0;
        }, 200);
        
        if (accumulatedDelta > threshold) {
          onScrollRight?.();
          accumulatedDelta = 0;
        } else if (accumulatedDelta < -threshold) {
          onScrollLeft?.();
          accumulatedDelta = 0;
        }
      }
    };

    const element = containerRef.current;
    element.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      element.removeEventListener('wheel', handleWheel);
      clearTimeout(timeoutId);
    };
  }, [enabled, onScrollLeft, onScrollRight, containerRef, threshold]);
};



