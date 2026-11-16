import type { KeyboardEvent } from 'react';

/**
 * The keyboard half of a list row that acts as a button without being one (role="button" on a div or an article, so it
 * can hold buttons of its own): Enter or Space pressed on the focused row opens it, once per press. Only lazily loaded
 * screens import this file.
 */

/** What isActivationKey reads from a key press; a React keyboard event has all of it. */
export interface KeyPress {
  key: string;
  repeat: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}

/**
 * Whether a key press activates the row: Enter or Space, pressed on the row itself and not held. A key pressed on a
 * control inside the row (its Reviewed or Delete button) is that control's, and a held key's repeats do nothing.
 */
export function isActivationKey(event: KeyPress): boolean {
  return event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ') && !event.repeat;
}

/**
 * A keydown handler that calls `onActivate` for a press that activates the row (isActivationKey) and takes the press:
 * Space doesn't scroll the page, and the card or lesson the row opens, which listens for Enter and Space on window,
 * doesn't take the same press as well.
 */
export function activateOnEnterOrSpace<T extends Element>(onActivate: () => void): (event: KeyboardEvent<T>) => void {
  return event => {
    if (!isActivationKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
}
