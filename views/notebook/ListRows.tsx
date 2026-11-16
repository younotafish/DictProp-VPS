import React from 'react';
import { Archive, ChevronDown, ChevronUp, Filter, Wand2 } from 'lucide-react';
import { filterNoun, type ListNoteContent, type NotebookFilter } from '../../services/notebookList';

/** Why nothing is listed above the due and archived sections, and the ways out (listNoteFor decides which). */
export const ListNote: React.FC<{ note: ListNoteContent; onLookUp: () => void; onShowAll: () => void }> = ({ note, onLookUp, onShowAll }) => (
  <div className="mx-3 mt-3 px-4 py-5 bg-white border border-dashed border-slate-200 rounded-2xl text-center">
    <p className="text-sm text-slate-500">{note.message}</p>
    {(note.offerLookUp || note.offerShowAll) && (
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {note.offerLookUp && (
          <button
            onClick={onLookUp}
            className="min-h-11 px-4 inline-flex items-center gap-2 rounded-xl bg-violet-50 text-violet-700 text-sm font-semibold hover:bg-violet-100 transition-colors"
          >
            <Wand2 size={16} /> Look it up with AI
          </button>
        )}
        {note.offerShowAll && (
          <button
            onClick={onShowAll}
            className="min-h-11 px-4 inline-flex items-center gap-2 rounded-xl bg-indigo-50 text-indigo-700 text-sm font-semibold hover:bg-indigo-100 transition-colors"
          >
            <Filter size={16} /> Show all items
          </button>
        )}
      </div>
    )}
  </div>
);

/** Heads the due items a search leaves out, listed after its results, named for what the filter lists. */
export const DueHeader: React.FC<{ count: number; filter: NotebookFilter }> = ({ count, filter }) => (
  <div className="px-3 mt-4 pt-3 border-t border-dashed border-orange-200">
    <div className="flex items-center gap-2 px-1 mb-3">
      <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide">Due for Review</span>
      <span className="text-xs text-slate-400">{count} {filterNoun(filter, count)} to revisit</span>
    </div>
  </div>
);

/** Heads a search's archived matches, listed open after its other results. */
export const ArchivedMatchesHeader: React.FC<{ count: number }> = ({ count }) => (
  <div className="px-3 mt-4 pt-3 border-t border-dashed border-slate-200">
    <div className="flex items-center gap-2 px-1 mb-3">
      <Archive size={14} className="text-slate-400" />
      <span className="text-xs font-bold text-slate-500">Archived matches · {count}</span>
    </div>
  </div>
);

/**
 * Opens and closes the archived section at the end of the list. It counts spellings, named for what the filter lists.
 */
export const ArchivedToggle: React.FC<{ count: number; filter: NotebookFilter; expanded: boolean; onToggle: () => void }> = ({
  count, filter, expanded, onToggle,
}) => (
  <div className="px-3 mt-6 pt-4 border-t-2 border-slate-200">
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full flex items-center justify-between px-4 py-3 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
    >
      <div className="flex items-center gap-3">
        <Archive size={18} className="text-slate-500" />
        <span className="font-bold text-slate-700">Archived</span>
        <span className="text-sm text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
          {count} {filterNoun(filter, count)}
        </span>
      </div>
      {expanded ? (
        <ChevronUp size={18} className="text-slate-500" />
      ) : (
        <ChevronDown size={18} className="text-slate-500" />
      )}
    </button>
  </div>
);
