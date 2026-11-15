import { useState } from 'react';
import type React from 'react';

/** What a backdrop's handler sees of an event: the element it is for, and the backdrop itself. */
interface BackdropEvent { target: EventTarget | null; currentTarget: EventTarget | null }

/**
 * Tells a click outside a dialog from a press that began inside it. Browsers send a click whose press and
 * release land on different elements to the nearest element holding both, so a text selection dragged out of
 * a dialog and released over its backdrop reaches the backdrop as a click on the backdrop itself. Only a click
 * whose press the backdrop saw begin on itself counts as outside.
 */
export function createBackdropPress() {
  let pressedOnBackdrop = false;
  return {
    /** For the backdrop's pointerdown. */
    press(e: BackdropEvent): void {
      pressedOnBackdrop = e.target === e.currentTarget;
    },
    /** For the backdrop's click: whether it was a click outside the dialog. */
    isClickOutside(e: BackdropEvent): boolean {
      const outside = pressedOnBackdrop && e.target === e.currentTarget;
      pressedOnBackdrop = false;
      return outside;
    },
  };
}

/** The backdrop's pointerdown and click handlers, which pass on only clicks outside the dialog to `onClick`. */
export function useBackdropClick<E extends HTMLElement>(onClick: (e: React.MouseEvent<E>) => void) {
  const [press] = useState(createBackdropPress);
  return {
    onPointerDown: (e: React.PointerEvent<E>) => press.press(e),
    onClick: (e: React.MouseEvent<E>) => { if (press.isClickOutside(e)) onClick(e); },
  };
}
