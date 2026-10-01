import React, { useEffect, useRef } from 'react';
import { useEscapeLayer } from './escapeStack';
import { useOverlay } from './overlayStack';

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Tailwind max-width for the panel (default max-w-md). */
  maxWidth?: string;
  /** Extra panel classes (e.g. 'max-h-[85vh] flex flex-col' for a scrolling body). */
  panelClassName?: string;
  /** Accessible label for the dialog. */
  ariaLabel?: string;
}

/**
 * While `active`, focuses the dialog panel, keeps Tab inside it, and on close gives focus back to what had it.
 * Runs once per open: callers pass inline handlers, and re-running on each render would pull focus back to
 * the panel and away from whatever the user had focused inside it.
 */
export function useModalFocus(panelRef: React.RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      const list = focusables ? Array.from(focusables).filter((el) => el.offsetParent !== null) : [];
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      const activeEl = document.activeElement as HTMLElement;
      if (e.shiftKey && (activeEl === first || activeEl === panelRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ } };
  }, [active, panelRef]);
}

/**
 * Centered modal shell: dim backdrop, click-outside / Escape to close, focus trap, an inert page behind, and
 * focus restore on close — plus role="dialog"/aria-modal. Extracted so the half-dozen modals stop
 * re-implementing the same backdrop markup (and gain the a11y they were each missing). Render your
 * header/body as children, and render the modal outside the app's `<main>` (beside it, or in a portal).
 */
export const Modal: React.FC<ModalProps> = ({ onClose, children, maxWidth = 'max-w-md', panelClassName = '', ariaLabel }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(onClose, 100);

  useOverlay();
  useModalFocus(panelRef);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4 fade-in"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`bg-white rounded-2xl shadow-2xl w-full ${maxWidth} overflow-hidden outline-none ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
