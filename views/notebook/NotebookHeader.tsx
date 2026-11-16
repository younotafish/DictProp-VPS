import React from 'react';
import { ArrowDownAZ, Filter, Layers, Scale, Sparkles, Type } from 'lucide-react';
import type { AuthUser } from '../../services/auth';
import { NEEDS_CONNECTION, networkRowDisabled } from '../../services/connectivityNotice';
import { filterNoun, type NotebookFilter, type NotebookSort } from '../../services/notebookList';
import { UserMenu } from '../../components/UserMenu';

interface NotebookHeaderProps {
  /** Hidden and shown by class as the list scrolls, so scrolling never re-renders the notebook. */
  headerRef: React.Ref<HTMLDivElement>;
  /** Spellings under the filter, named for what it lists (words, phrases or items), so a kept filter shows. */
  savedCount: number;
  reviewedToday: number;
  /** Spellings due by the notebook's rule, never-reviewed ones included: what the list marks Due. */
  toReviewCount: number;
  /**
   * An outage has settled: the controls that need the server stay in place, disabled (services/connectivityNotice), so
   * the header keeps its shape offline.
   */
  offline: boolean;
  /** The tools menu, first in the toolbar. */
  toolsMenu: React.ReactNode;
  /** Nothing is saved, so the compare, filter and sort buttons, which act on the list, are left out. */
  empty: boolean;
  compareMode: boolean;
  onToggleCompare: () => void;
  filterMode: NotebookFilter;
  onCycleFilter: () => void;
  sortMode: NotebookSort;
  onCycleSort: () => void;
  user: AuthUser;
  /** Resolves false when the server couldn't be reached and the session was kept. */
  onSignOut: () => Promise<boolean>;
  onViewRefusedReviews: () => void;
  /** Under the title row: the search bar and a running batch import's progress. */
  children: React.ReactNode;
}

/** The compare toggle. Offline, compare mode can't start, since comparing needs the server; one already on can be left. */
const CompareToggle: React.FC<{ offline: boolean; compareMode: boolean; onToggle: () => void }> = ({ offline, compareMode, onToggle }) => {
  const disabled = networkRowDisabled('compare', !offline) && !compareMode;
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-label="Compare words"
      aria-pressed={compareMode}
      className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
        compareMode
          ? 'text-indigo-600 bg-indigo-100'
          : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
      }`}
      title={disabled ? NEEDS_CONNECTION : compareMode ? 'Exit compare mode' : 'Compare words — select 2-3 to compare'}
    >
      <Scale size={16} />
    </button>
  );
};

/** The notebook's sticky header: its title and counts, the toolbar, and the search bar below them. */
export const NotebookHeader: React.FC<NotebookHeaderProps> = ({
  headerRef, savedCount, reviewedToday, toReviewCount, offline, toolsMenu, empty, compareMode, onToggleCompare,
  filterMode, onCycleFilter, sortMode, onCycleSort, user, onSignOut, onViewRefusedReviews, children,
}) => (
  <div ref={headerRef} className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200/50 transition-transform duration-300">
    <div className="px-4 sm:px-6 py-4 flex justify-between items-center gap-3">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
        <p className="text-xs text-slate-500 font-medium truncate">{savedCount} {filterNoun(filterMode, savedCount)} · {reviewedToday} reviewed today · {toReviewCount} to review</p>
      </div>
      <div className="flex flex-wrap md:flex-nowrap items-center justify-end gap-1 min-w-0">
        {toolsMenu}
        {!empty && (
          <>
            <CompareToggle offline={offline} compareMode={compareMode} onToggle={onToggleCompare} />
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
          </>
        )}
        <div className="hidden md:block h-4 w-[1px] bg-slate-200 mx-1 shrink-0"></div>
        <div className="shrink-0">
          <UserMenu
            user={user}
            onSignOut={onSignOut}
            onViewRefusedReviews={onViewRefusedReviews}
            offline={offline}
          />
        </div>
      </div>
    </div>
    {children}
  </div>
);
