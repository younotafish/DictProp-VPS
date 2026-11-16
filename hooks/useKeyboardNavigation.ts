/**
 * The card view's navigation keys: the arrows, Enter and Cmd/Ctrl+S. Space and Cmd/Ctrl+F are kept from the
 * browser here too. The letter shortcuts live with each view (useWordShortcuts, useSentenceShortcuts), Escape goes
 * through the escape stack (useEscapeLayer), and the tab keys 1/2/3 are useGlobalNavigation's.
 */

import { useEffect, RefObject } from 'react';
import { useLatest } from './useStableValue';
import { acceptKeyRepeat, isImeKey, isTypingTarget } from '../components/keyboardTarget';

interface NavKeyHandlers {
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onEnter?: () => void;
  onSave?: () => void; // Cmd+S
}

interface KeyboardNavigationOptions extends NavKeyHandlers {
  /** True while a layer above the view (a sheet or a dialog) has the keys, so the view leaves them alone. */
  guard?: () => boolean;
  enabled?: boolean;
}

/** What decides whether the view takes a key press. */
export interface NavKeyContext {
  /** The key goes into a text field, select or editable region. */
  typing: boolean;
  /** The input method is composing with it, like the Enter that picks a candidate. */
  ime: boolean;
  /** The view's guard said a layer above the view has the keys. */
  guard: boolean;
}

/**
 * Whether the view acts on a press of one of its keys: never while the key goes into text or an input method or a
 * layer above the view has the keys, and for a held key only an arrow's repeats (acceptKeyRepeat), so holding Enter
 * reads from the word once while holding ↓ keeps stepping.
 */
export function shouldHandleNavKey(event: Pick<KeyboardEvent, 'key' | 'repeat'>, { typing, ime, guard }: NavKeyContext): boolean {
  return !typing && !ime && !guard && acceptKeyRepeat(event);
}

/** What the view's keys read from a key press. */
export type NavKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'preventDefault' | 'stopImmediatePropagation'>;

/** One key press on the view, with the handlers of the card on screen. */
export function handleNavKey(e: NavKeyEvent, context: NavKeyContext, handlers: NavKeyHandlers): void {
  const { onArrowLeft, onArrowRight, onArrowUp, onArrowDown, onEnter, onSave } = handlers;
  const act = shouldHandleNavKey(e, context);

  // Cmd+S - Save; never the browser's Save Page dialog, even when the view leaves the key alone
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (act) onSave?.();
    return;
  }

  // Cmd+F is the app's search (GlobalSearch takes it), never the browser's Find
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    return;
  }

  // The view's escape layer does the closing; this only keeps the browser's default action off.
  if (e.key === 'Escape') {
    e.preventDefault();
    return;
  }

  // A text field, the input method or a layer above the view (the search sheet, a confirm, the shortcut list) keeps
  // the other keys, browser defaults and all: with the sheet open, ↑/↓ scroll its card, not the sentences behind it.
  if (context.typing || context.ime || context.guard) return;

  switch (e.key) {
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
      // Held, Enter reads from the word once: its repeats only keep the browser's default off.
      e.preventDefault();
      if (act) onEnter?.();
      break;

    case ' ':
      // Space never scrolls the card, including the held repeats the letter shortcuts ignore.
      e.preventDefault();
      break;
  }
}

export const useKeyboardNavigation = (options: KeyboardNavigationOptions) => {
  const enabled = options.enabled ?? true;
  // Callers pass fresh handlers on most renders; reading them through a ref registers the listener once.
  const optionsRef = useLatest(options);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const current = optionsRef.current;
      handleNavKey(e, { typing: isTypingTarget(e.target), ime: isImeKey(e), guard: current.guard?.() ?? false }, current);
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
