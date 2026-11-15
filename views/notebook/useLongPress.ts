import { useEffect, useRef } from 'react';
import type React from 'react';

/** How long a press is held before it counts as a long press. */
const LONG_PRESS_MS = 500;
/** How far a pressing finger may drift and still be holding, not scrolling or swiping. */
const MOVE_TOLERANCE_PX = 10;
/** How long after a long press its closing click is ignored. */
const CLICK_SUPPRESS_MS = 400;

/**
 * A press held still on the element, by touch or the main mouse button, or a right-click (which a touch long
 * press can raise early): either calls `onLongPress`. A finger that moves is scrolling or swiping instead. The
 * click that ends a held mouse press is reported by isClickSuppressed, so the handler can ignore it.
 */
export function useLongPress(onLongPress: () => void) {
  const longPressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  // A mouse press held long enough to open the actions ends in a click, which would close them again.
  const ignoreClicksUntil = useRef(0);

  const handlePressStart = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    pressStart.current = { x: e.clientX, y: e.clientY };
    longPressFired.current = false;
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressFired.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const handlePressEnd = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (longPressFired.current) ignoreClicksUntil.current = Date.now() + CLICK_SUPPRESS_MS;
    longPressFired.current = false;
    pressStart.current = null;
  };

  // A finger that moves is scrolling or swiping to another meaning, not holding.
  const handlePressMove = (e: React.PointerEvent) => {
    const start = pressStart.current;
    if (start && longPressTimer.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE_PX) {
      handlePressEnd();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // A touch long press can raise the context menu before the timer runs out.
    if (pressStart.current) longPressFired.current = true;
    onLongPress();
  };

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  /** Whether a click now is the end of a long press, which already did its job. */
  const isClickSuppressed = () => Date.now() < ignoreClicksUntil.current;

  return {
    pressHandlers: {
      onPointerDown: handlePressStart,
      onPointerMove: handlePressMove,
      onPointerUp: handlePressEnd,
      onPointerLeave: handlePressEnd,
      onPointerCancel: handlePressEnd,
      onContextMenu: handleContextMenu,
    },
    isClickSuppressed,
  };
}
