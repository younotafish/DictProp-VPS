import { useEffect, useSyncExternalStore, type RefObject } from 'react';

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
export const useAnyOverlayOpen = (): boolean => useSyncExternalStore(subscribe, anyOpen, () => false);

// The dialogs open (components/Modal), wherever they render: App's own, UserMenu's sign-out confirmations and an
// overlay's crash dialog alike. A dialog keeps the keys, so App stands its shortcuts down while any is open (see
// hooks/useOverlays' modalOpen).
let openModalCount = 0;

/** Registers the calling dialog (components/Modal) while it's mounted. */
export function useModalDialog(): void {
  useEffect(() => {
    if (openModalCount++ === 0) emit();
    return () => { if (--openModalCount === 0) emit(); };
  }, []);
}

const anyModalOpen = () => openModalCount > 0;

/** Whether a dialog (components/Modal) is open anywhere in the app. */
export const useAnyModalDialogOpen = (): boolean => useSyncExternalStore(subscribe, anyModalOpen, () => false);

/** The element that had focus when the first open overlay opened; reading it clears it. */
export function takeOverlayOpener(): Element | null {
  const element = opener;
  opener = null;
  return element;
}

/**
 * Gives focus back once the last overlay has closed, to the control that opened the first. `main` is the page
 * and `nav` the nav bar, read as they are now, when the page has just become live again.
 */
function returnFocus(mainRef: RefObject<HTMLElement | null>, navRef: RefObject<HTMLElement | null>): void {
  const opener = takeOverlayOpener();
  const main = mainRef.current;
  const active = document.activeElement;
  const focusLost = !active || active === document.body || !active.isConnected || !!active.closest('[inert]');
  if (!focusLost || !main) return;
  // Not into a text field, where focus would bring up the on-screen keyboard.
  if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]')
    && (main.contains(opener) || navRef.current?.contains(opener))
    && !opener.matches('input, textarea, select, [contenteditable]')) {
    opener.focus({ preventScroll: true });
    if (document.activeElement === opener) return;
  }
  // The opener is gone (Clear all takes the refused-reviews badge with it), is a text field or can't take
  // focus, so the page takes it rather than leaving it on the body. The page stays focusable only until
  // focus moves on, so a click on its background never lands on it and keyboard scrolling still follows
  // the click.
  if (!main.hasAttribute('tabindex')) {
    main.tabIndex = -1;
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  }
  main.focus({ preventScroll: true });
}

/**
 * For the app shell: whether any overlay is open, and focus back where it belongs when the last one closes.
 * An open card, popup, dialog or search result covers the page and the nav bar, which leave the tab order and
 * the accessibility tree meanwhile. Overlays render beside <main>, never in it. When the last one closes, the
 * cleanup runs after the commit that made the page live again, so focus can go back to the control that
 * opened the first; the overlay's own restore ran while it was inert.
 */
export function useOverlayFocusReturn(mainRef: RefObject<HTMLElement | null>, navRef: RefObject<HTMLElement | null>): boolean {
  const overlayOpen = useAnyOverlayOpen();
  useEffect(() => {
    if (!overlayOpen) return;
    return () => returnFocus(mainRef, navRef);
  }, [overlayOpen, mainRef, navRef]);
  return overlayOpen;
}
