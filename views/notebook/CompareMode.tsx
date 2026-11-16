import React from 'react';
import { Check, Scale, X } from 'lucide-react';
import type { ItemGroup } from '../../types';
import type { NotebookSection } from '../../services/notebookList';
import { MAX_COMPARE_WORDS } from '../../server/src/shared/query-mode';
import { NotebookGroup } from './NotebookGroup';

const noop = () => {};

/**
 * Whether `word` can be ticked, or unticked, with `selected` ticked: one comparison takes up to MAX_COMPARE_WORDS
 * words, as the word card's picker and /api/compare do.
 */
export const canSelectForCompare = (selected: readonly string[], word: string): boolean =>
  selected.includes(word) || selected.length < MAX_COMPARE_WORDS;

/** Heads the list in compare mode: what to do, how many are picked, and the way out. */
export const CompareBanner: React.FC<{ selectedCount: number; onExit: () => void }> = ({ selectedCount, onExit }) => (
  <div className="px-3 pt-3">
    <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3">
      <div className="flex items-center gap-2">
        <Scale size={16} className="text-indigo-500" />
        <span className="text-sm font-medium text-indigo-700">
          Select 2–{MAX_COMPARE_WORDS} words to compare
        </span>
        {selectedCount > 0 && (
          <span className="text-xs font-bold text-indigo-500 bg-indigo-100 px-2 py-0.5 rounded-full">
            {selectedCount} selected
          </span>
        )}
      </div>
      <button
        onClick={onExit}
        className="text-indigo-400 hover:text-indigo-600 p-1 rounded-full hover:bg-indigo-100 transition-colors"
        title="Exit compare mode"
      >
        <X size={16} />
      </button>
    </div>
  </div>
);

interface CompareRowProps {
  group: ItemGroup;
  section: NotebookSection;
  now: number;
  displayWord: string;
  isSelected: boolean;
  canSelect: boolean;
  onToggle: () => void;
}

/** A listed word in compare mode: a checkbox over its card, which is shown but can't be used meanwhile. */
export const CompareRow: React.FC<CompareRowProps> = ({ group, section, now, displayWord, isSelected, canSelect, onToggle }) => (
  <div className="px-3 py-1.5">
    <div
      role="checkbox"
      tabIndex={0}
      aria-checked={isSelected}
      aria-disabled={!canSelect}
      aria-label={displayWord}
      className={`relative cursor-pointer transition-all ${isSelected ? 'ring-2 ring-indigo-400 rounded-2xl' : ''}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
        isSelected
          ? 'bg-indigo-500 border-indigo-500 text-white'
          : canSelect
            ? 'bg-white border-slate-300'
            : 'bg-slate-100 border-slate-200 opacity-50'
      }`}>
        {isSelected && <Check size={14} />}
      </div>
      <div className="pointer-events-none" inert>
        <NotebookGroup
          group={group}
          section={section}
          now={now}
          onViewDetail={noop}
          onDelete={noop}
        />
      </div>
    </div>
  </div>
);

/** Floats above the tab bar once two or more words are picked. */
export const CompareSelectedButton: React.FC<{ count: number; onCompare: () => void }> = ({ count, onCompare }) => (
  <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-0 right-0 flex justify-center z-20 pointer-events-none">
    <button
      onClick={onCompare}
      className="pointer-events-auto px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full shadow-lg hover:shadow-xl transition-all flex items-center gap-2 duration-200"
    >
      <Scale size={18} />
      Compare {count} Words
    </button>
  </div>
);
