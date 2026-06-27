import React, { useEffect, useRef } from 'react';

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
 * Centered modal shell: dim backdrop, click-outside / Escape to close, focus trap, and focus restore on
 * close — plus role="dialog"/aria-modal. Extracted so the half-dozen modals stop re-implementing the
 * same backdrop markup (and gain the a11y they were each missing). Render your header/body as children.
 */
export const Modal: React.FC<ModalProps> = ({ onClose, children, maxWidth = 'max-w-md', panelClassName = '', ariaLabel }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Tab') {
        const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
        );
        const list = focusables ? Array.from(focusables).filter((el) => el.offsetParent !== null) : [];
        if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); try { prevFocus?.focus?.(); } catch { /* ignore */ } };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`bg-white rounded-2xl shadow-2xl w-full ${maxWidth} overflow-hidden outline-none animate-in zoom-in-95 duration-200 ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
