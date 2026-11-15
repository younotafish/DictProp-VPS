import React from 'react';
import { ArrowDownAZ, Filter, Layers, Scale, Sparkles, Type, WifiOff } from 'lucide-react';
import type { AppUser } from '../../types';
import type { NotebookFilter, NotebookSort } from '../../services/notebookList';
import { UserMenu } from '../../components/UserMenu';

interface NotebookHeaderProps {
  /** Hidden and shown by class as the list scrolls, so scrolling never re-renders the notebook. */
  headerRef: React.Ref<HTMLDivElement>;
  savedCount: number;
  reviewedToday: number;
  dueCount: number;
  isOnline: boolean;
  /** The tools menu, first in the toolbar. */
  toolsMenu: React.ReactNode;
  compareMode: boolean;
  onToggleCompare: () => void;
  filterMode: NotebookFilter;
  onCycleFilter: () => void;
  sortMode: NotebookSort;
  onCycleSort: () => void;
  user: AppUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  /** The search bar, under the title row. */
  children: React.ReactNode;
}

/** The notebook's sticky header: its title and counts, the toolbar, and the search bar below them. */
export const NotebookHeader: React.FC<NotebookHeaderProps> = ({
  headerRef, savedCount, reviewedToday, dueCount, isOnline, toolsMenu, compareMode, onToggleCompare,
  filterMode, onCycleFilter, sortMode, onCycleSort, user, onSignIn, onSignOut, children,
}) => (
  <div ref={headerRef} className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200/50 transition-transform duration-300">
    <div className="px-4 sm:px-6 py-4 flex justify-between items-center gap-3">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
        <p className="text-xs text-slate-500 font-medium truncate">{savedCount} saved · {reviewedToday} reviewed today · {dueCount} due</p>
      </div>
      <div className="flex flex-wrap md:flex-nowrap items-center justify-end gap-1 min-w-0">
        {toolsMenu}
        {/* Compare mode toggle */}
        {isOnline && (
          <button
            onClick={onToggleCompare}
            aria-label="Compare words"
            aria-pressed={compareMode}
            className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-full transition-colors ${
              compareMode
                ? 'text-indigo-600 bg-indigo-100'
                : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
            }`}
            title={compareMode ? 'Exit compare mode' : 'Compare words — select 2-3 to compare'}
          >
            <Scale size={16} />
          </button>
        )}
        <button
          onClick={onCycleFilter}
          className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors ${filterMode !== 'all' ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500'}`}
          title={`Filter: ${filterMode === 'all' ? 'All Items' : filterMode === 'vocab' ? 'Vocabulary Only' : 'Phrases Only'}`}
        >
          {filterMode === 'all' && <Filter size={16} />}
          {filterMode === 'vocab' && <Type size={16} />}
          {filterMode === 'phrase' && <Layers size={16} />}
        </button>
        <button
          onClick={onCycleSort}
          className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors"
          title={sortMode === 'familiarity' ? 'Sort: Review Priority' : 'Sort: A-Z'}
        >
          {sortMode === 'familiarity' ? <Sparkles size={16} /> : <ArrowDownAZ size={16} />}
        </button>
        <div className="hidden md:block h-4 w-px bg-slate-200 mx-1 shrink-0"></div>
        {!isOnline && (
          <div className="w-11 h-11 flex items-center justify-center text-amber-500 shrink-0" title="Offline">
            <WifiOff size={14} />
          </div>
        )}
        {user && (
          <>
            <div className="hidden md:block h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
            <div className="shrink-0">
              <UserMenu
                user={user}
                onSignIn={onSignIn}
                onSignOut={onSignOut}
              />
            </div>
          </>
        )}
      </div>
    </div>
    {children}
  </div>
);
