import { useEffect, useSyncExternalStore } from 'react';

/**
 * While a dialog, popup or sheet is open, the page behind it is inert: out of the tab order, the
 * accessibility tree and the pointer's reach, so focus can't wander off the dialog. Each overlay registers
 * here while it's open; the app shell makes its background inert while any is registered and, when the last
 * one closes, gives focus back to the control that opened the first.
 *
 * An overlay registers from a passive effect declared before the effect that moves focus into it, so the
 * opener is recorded while it still has focus, before the background goes inert. Overlays must render
 * outside the inert background (beside it, or through a portal), or they would be inert themselves.
 */
let openCount = 0;
let opener: Element | null = null;
const listeners = new Set<() => void>();

const emit = () => { for (const listener of listeners) listener(); };

/** Registers an open overlay; the returned function unregisters it, once. */
export function openOverlay(): () => void {
  if (openCount++ === 0) {
    // Focus on the body says nothing about where it came from: an overlay that closed in the same commit as
    // this one opened leaves it there, and the control that opened that one is still the one to return to.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) opener = active;
    emit();
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--openCount === 0) emit();
  };
}

/** Registers the calling overlay while `active`. Declare it before the overlay's own focus effect. */
export function useOverlay(active = true): void {
  useEffect(() => (active ? openOverlay() : undefined), [active]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const anyOpen = () => openCount > 0;

/** Whether any overlay is open. */
export const useAnyOverlayOpen = (): boolean => useSyncExternalStore(subscribe, anyOpen);

/** The element that had focus when the first open overlay opened; reading it clears it. */
export function takeOverlayOpener(): Element | null {
  const element = opener;
  opener = null;
  return element;
}
