import React, { useEffect, useRef } from 'react';
import { Archive, ArchiveRestore, RotateCcw, Trash2 } from 'lucide-react';

interface DetailActionMenuProps {
  /** Offered instead of Archive when the card is archived. */
  onUnarchive?: () => void;
  onArchive?: () => void;
  onResetMemory: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** A saved card's More menu, fixed to the viewport so the header's overflow can't clip it. It takes focus when
 *  it opens; the arrow keys, Home and End move between its items, and Tab or a click outside closes it. */
export const DetailActionMenu: React.FC<DetailActionMenuProps> = ({ onUnarchive, onArchive, onResetMemory, onDelete, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') { onClose(); return; }
    else return;
    e.preventDefault();
    items[next].focus();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[55]"
        onClick={onClose}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label="More actions"
        onKeyDown={handleKeyDown}
        className="fixed right-4 top-12 z-[56] bg-white rounded-xl shadow-xl border border-slate-200 py-1 min-w-[180px] fade-in"
      >
        {onUnarchive ? (
          <button
            role="menuitem"
            onClick={onUnarchive}
            className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 flex items-center gap-2.5 transition-colors"
          >
            <ArchiveRestore size={16} />
            Unarchive
          </button>
        ) : onArchive && (
          <button
            role="menuitem"
            onClick={onArchive}
            className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 flex items-center gap-2.5 transition-colors"
          >
            <Archive size={16} />
            Archive
          </button>
        )}
        <button
          role="menuitem"
          onClick={onResetMemory}
          className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2.5 transition-colors"
        >
          <RotateCcw size={16} />
          Reset Memory Strength
        </button>
        <button
          role="menuitem"
          onClick={onDelete}
          className="w-full px-4 py-2.5 text-left text-sm text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 transition-colors"
        >
          <Trash2 size={16} />
          Delete
        </button>
      </div>
    </>
  );
};
