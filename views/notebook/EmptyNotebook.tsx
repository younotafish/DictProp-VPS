import React from 'react';
import { BookOpen, Search } from 'lucide-react';
import { requestLookup } from '../../services/searchRequests';

interface EmptyNotebookProps {
  query: string;
  onQueryChange: (query: string) => void;
}

/**
 * The notebook with nothing saved in it, under its header: an invitation and a box to look up the first word. The
 * search looks the submitted text up as typed text, as its own box does, so a sentence is scanned for its expressions.
 */
export const EmptyNotebook: React.FC<EmptyNotebookProps> = ({ query, onQueryChange }) => (
  <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
    <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
      <BookOpen size={32} className="text-indigo-300" />
    </div>
    <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
    <p className="text-sm mb-8 max-w-xs mx-auto">Search for a word or phrase to get started.</p>

    <div className="w-full max-w-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) requestLookup({ query: query.trim(), source: 'text' });
        }}
        className="relative"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          enterKeyHint="search"
          placeholder="Search a word or phrase..."
          className="w-full px-4 py-3 pr-12 rounded-xl border border-slate-200 bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
          autoFocus
        />
        <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 text-indigo-500 hover:text-indigo-700">
          <Search size={20} />
        </button>
      </form>
    </div>
  </div>
);
