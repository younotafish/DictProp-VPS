import React from 'react';
import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';

const ShortcutRow: React.FC<{ keys: string[]; description: string }> = ({ keys, description }) => (
  <div className="flex items-center justify-between py-1.5">
    <span className="text-sm text-slate-600">{description}</span>
    <div className="flex items-center gap-1">
      {keys.map((key, i) => (
        <React.Fragment key={i}>
          <kbd className="min-w-[24px] h-6 px-1.5 bg-slate-100 border border-slate-200 rounded text-xs font-mono font-medium text-slate-700 flex items-center justify-center shadow-sm">
            {key}
          </kbd>
          {i < keys.length - 1 && <span className="text-slate-300 text-xs">+</span>}
        </React.Fragment>
      ))}
    </div>
  </div>
);

/** The "?" keyboard-shortcuts reference sheet. Extracted from App.tsx (was ~110 lines of inline JSX). */
export const KeyboardHelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <Modal onClose={onClose} maxWidth="max-w-md" panelClassName="max-h-[80vh] overflow-y-auto" ariaLabel="Keyboard shortcuts">
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center">
          <Keyboard size={24} />
        </div>
        <div>
          <h3 className="text-xl font-bold text-slate-800">Keyboard Shortcuts</h3>
          <p className="text-sm text-slate-500">Navigate faster with your keyboard</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Navigation */}
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Navigation</h4>
          <div className="space-y-2">
            <ShortcutRow keys={['1']} description="Go to Notebook" />
            <ShortcutRow keys={['2']} description="Go to Sentences" />
            <ShortcutRow keys={['3']} description="Go to Study" />
            <ShortcutRow keys={['⌘', 'F']} description="Focus search input" />
            <ShortcutRow keys={['?']} description="Show keyboard shortcuts" />
            <ShortcutRow keys={['Esc']} description="Close modal / Go back / Clear search" />
          </div>
        </div>

        {/* Cards & Carousels */}
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Card View</h4>
          <div className="space-y-2">
            <ShortcutRow keys={['←', '→']} description="Navigate between meanings" />
            <ShortcutRow keys={['↑', '↓']} description="Navigate between words" />
            <ShortcutRow keys={['S']} description="Toggle save" />
            <ShortcutRow keys={['P']} description="Pronounce current word" />
            <ShortcutRow keys={['R']} description="Mark as Remembered" />
            <ShortcutRow keys={['Shift', 'R']} description="Reset memory strength" />
            <ShortcutRow keys={['H']} description="Toggle header bar" />
            <ShortcutRow keys={['D']} description="Delete current item" />
            <ShortcutRow keys={['A']} description="Archive / Unarchive" />
            <ShortcutRow keys={['E']} description="Speak example sentence(s)" />
            <ShortcutRow keys={['⌘', '1']} description="Speak 1st example sentence" />
            <ShortcutRow keys={['⌘', '2']} description="Speak 2nd example sentence" />
            <ShortcutRow keys={['Space']} description="Auto-play" />
          </div>
        </div>

        {/* Sentences flow */}
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Sentences</h4>
          <div className="space-y-2">
            <ShortcutRow keys={['Tap']} description="Open a sentence to study it" />
            <ShortcutRow keys={['↑', '↓']} description="Switch between saved sentences" />
            <ShortcutRow keys={['E']} description="Speak the saved sentence (natural voice)" />
            <ShortcutRow keys={['Space']} description="Pause / resume sentence · auto-play when idle" />
            <ShortcutRow keys={['Tap', 'ⁿ']} description="Footnote on a saved word → open its full card" />
            <ShortcutRow keys={['R']} description="Remember (stays on the sentence)" />
            <ShortcutRow keys={['Shift', 'R']} description="Reset memory strength" />
            <ShortcutRow keys={['D']} description="Delete the sentence" />
            <ShortcutRow keys={['Esc']} description="Back to Sentences" />
          </div>
        </div>

        {/* Word card popup (opened from a sentence footnote) */}
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Word card popup</h4>
          <div className="space-y-2">
            <ShortcutRow keys={['R']} description="Got it (remember)" />
            <ShortcutRow keys={['Shift', 'R']} description="Reset memory" />
            <ShortcutRow keys={['D']} description="Delete word" />
            <ShortcutRow keys={['P']} description="Pronounce the word" />
            <ShortcutRow keys={['E']} description="Speak an example" />
            <ShortcutRow keys={['Space']} description="Play / pause" />
            <ShortcutRow keys={['Esc']} description="Close the card" />
          </div>
        </div>

        {/* Trackpad */}
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Trackpad Gestures</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm text-slate-600">Two-finger horizontal swipe</span>
              <span className="text-xs text-slate-400">Navigate cards</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm text-slate-600">Two-finger vertical swipe</span>
              <span className="text-xs text-slate-400">Navigate words</span>
            </div>
          </div>
        </div>
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
