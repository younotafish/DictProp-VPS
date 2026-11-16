import React, { useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';
import { isMacPlatform } from '../services/platform';
import { keyChords, sheetSections, type ShortcutRow, type ShortcutSectionId } from '../services/shortcutSheet';

/** Sections whose rows name a gesture rather than keys. */
const GESTURE_SECTIONS: ReadonlySet<ShortcutSectionId> = new Set(['touch', 'trackpad']);

/** A phone or tablet, whose sheet starts with its gestures. */
const hasCoarsePointer = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

/** One row: what it does, then its keys, the chords to choose from (/) with a modifier's keys joined by +. */
const SheetRow: React.FC<{ row: ShortcutRow; gesture: boolean }> = ({ row, gesture }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <span className="text-sm text-slate-600">{row.label}</span>
    {gesture ? (
      <span className="shrink-0 max-w-[45%] text-right text-xs font-medium text-slate-500">{row.keys.join(' / ')}</span>
    ) : (
      <div className="flex shrink-0 items-center gap-1">
        {keyChords(row.keys).map((chord, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-slate-300 text-xs">/</span>}
            {chord.map((key, j) => (
              <React.Fragment key={j}>
                {j > 0 && <span className="text-slate-300 text-xs">+</span>}
                <kbd className="min-w-[24px] h-6 px-1.5 bg-slate-100 border border-slate-200 rounded text-xs font-mono font-medium text-slate-700 flex items-center justify-center shadow-sm">
                  {key}
                </kbd>
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}
      </div>
    )}
  </div>
);

interface Props {
  onClose: () => void;
  /** List the touch gestures first; by default, when the main pointer is a finger. */
  touchFirst?: boolean;
  /** Name ⌘ rather than Ctrl; by default, on a Mac (or an iPad's keyboard). */
  isMac?: boolean;
}

/**
 * The gestures and shortcuts sheet, from services/shortcutSheet: the '?' key and the tab bar's ? button open it on a
 * laptop, the Notebook's ⋯ menu on a phone, where the touch gestures come first.
 */
export const KeyboardHelpModal: React.FC<Props> = ({ onClose, touchFirst, isMac }) => {
  // Read once, as the sheet opens.
  const [sections] = useState(() => sheetSections({ touchFirst: touchFirst ?? hasCoarsePointer(), isMac: isMac ?? isMacPlatform() }));
  return (
    <Modal onClose={onClose} maxWidth="max-w-md" panelClassName="max-h-[80vh] overflow-y-auto" ariaLabel="Gestures & shortcuts">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center">
            <Keyboard size={24} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-800">Gestures &amp; shortcuts</h3>
            <p className="text-sm text-slate-500">What each tap, swipe and key does</p>
          </div>
        </div>

        <div className="space-y-4">
          {sections.map(section => (
            <div key={section.id}>
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">{section.title}</h4>
              <div className="space-y-2">
                {section.rows.map((row, i) => <SheetRow key={i} row={row} gesture={GESTURE_SECTIONS.has(section.id)} />)}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
        >
          Got it
        </button>
      </div>
    </Modal>
  );
};
