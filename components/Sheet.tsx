import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, X } from 'lucide-react';
import { useEscapeLayer } from './escapeStack';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';

/** The button at the start of a sheet's header. Escape presses it too. */
export interface SheetButton {
  /** An X that closes the sheet, or a chevron that steps back within it. */
  kind: 'close' | 'back';
  /** Its accessible name. */
  label: string;
  onClick: () => void;
}

/** The header's button: the sheet's own, none (null), or else Close, labelled 'Close', calling `onClose`. */
export const sheetButton = (button: SheetButton | null | undefined, onClose: () => void): SheetButton | null =>
  button === undefined ? { kind: 'close', label: 'Close', onClick: onClose } : button;

interface SheetPanelProps {
  /** The id of the title, which names the dialog. */
  titleId: string;
  title: string;
  icon: React.ReactNode;
  subtitle?: React.ReactNode;
  button: SheetButton | null;
  panelRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

/**
 * A sheet as it shows: a full-screen dialog named by its title, the header's button before the title, and the
 * sheet's body below. Sheet renders it in a portal; a test renders it alone, which the server renderer can't do with
 * a portal.
 */
export const SheetPanel: React.FC<SheetPanelProps> = ({ titleId, title, icon, subtitle, button, panelRef, children }) => (
  <div
    ref={panelRef}
    tabIndex={-1}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    className="fixed inset-0 z-[45] bg-white flex flex-col outline-none"
  >
    {/* Header */}
    <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white flex items-center gap-3">
      {button && (
        <button
          onClick={button.onClick}
          aria-label={button.label}
          className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
        >
          {button.kind === 'back' ? <ChevronLeft size={20} /> : <X size={20} />}
        </button>
      )}
      <div className="flex-1">
        <h2 id={titleId} className="text-lg font-bold text-slate-800 flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {subtitle}
      </div>
    </div>
    {children}
  </div>
);

interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Beside the title, in the tool's colour. */
  icon: React.ReactNode;
  children: React.ReactNode;
  /** Under the title: what the sheet is doing now. */
  subtitle?: React.ReactNode;
  /** The header's button, which Escape presses too (see sheetButton): Close unless the sheet says otherwise. */
  button?: SheetButton | null;
}

/**
 * A Notebook tool's full-screen sheet (Batch import, Import JSON, the Text Analyzer) as a dialog, like every other
 * one in the app: Escape presses the header's button, Tab stays inside, the page behind is inert, and closing gives
 * focus back. It renders in a portal, outside the app's <main>, which goes inert while it's open.
 *
 * At z-[45], not the z-50 the sheets had: a portal at the end of <body> would paint over every z-50 layer in the app
 * root, and those (a card opened from the search above the sheet, the search's error screen) can only open after it,
 * so it stays beneath them, and above the tab bar (z-30). Its Escape layer sits at the same z.
 */
export const Sheet: React.FC<SheetProps> = ({ isOpen, onClose, title, icon, children, subtitle, button }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const headerButton = sheetButton(button, onClose);
  // Before the early return, in Modal's order: the overlay records the opener before focus moves into the panel.
  useEscapeLayer(() => headerButton?.onClick(), 45, isOpen);
  useOverlay(isOpen);
  useModalFocus(panelRef, isOpen);
  if (!isOpen) return null;
  return createPortal(
    <SheetPanel titleId={titleId} title={title} icon={icon} subtitle={subtitle} button={headerButton} panelRef={panelRef}>
      {children}
    </SheetPanel>,
    document.body,
  );
};
