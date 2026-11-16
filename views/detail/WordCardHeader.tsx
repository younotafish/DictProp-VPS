import type { RefObject } from 'react';
import { ArrowLeft, Bookmark, MoreVertical, RefreshCw, Trash2 } from 'lucide-react';
import type { SRSData, StoredItem } from '../../types';
import type { MasteryClasses } from '../../components/mastery';
import { Button } from '../../components/Button';
import { LibraryCounts } from './LibraryCounts';
import { SrsStats } from '../../components/review/SrsStats';

interface WordCardHeaderProps {
  /** Asked for (a short swipe down or H): it opens to its own height, and otherwise stays closed and inert. */
  showHeader: boolean;
  onClose: () => void;
  /** The meanings in this word's group, and which one is showing. */
  itemCount: number;
  itemIndex: number;
  onRefresh: () => void;
  /** A saved card offers Delete and the More menu; an unsaved one, Save. */
  isSaved: boolean;
  onDelete: () => void;
  onSave: () => void;
  moreActionsRef: RefObject<HTMLDivElement | null>;
  showActionMenu: boolean;
  onToggleActionMenu: () => void;
  /** The saved card's memory; null when the card isn't saved. */
  stats: { srs: SRSData; mastery: { label: string; color: string; percentage: number }; colors: MasteryClasses } | null;
  /** For the library-wide counts, scanned only while the header is open. */
  savedItems: StoredItem[];
}

/**
 * The word card's sticky header, combined with its progress bar: Close, the meaning's position, Refresh with AI, then
 * Delete and the More menu's button on a saved card or Save on an unsaved one, then the saved card's memory. Nothing
 * that looks like a status pill deletes. It opens to its own height when the learner asks for it and closes at once,
 * so a card change never slides the next card up after it appears.
 */
export function WordCardHeader({
  showHeader, onClose, itemCount, itemIndex, onRefresh, isSaved, onDelete, onSave, moreActionsRef,
  showActionMenu, onToggleActionMenu, stats, savedItems,
}: WordCardHeaderProps) {
  return (
    <div
      inert={!showHeader}
      className={`sticky top-0 z-30 grid ${showHeader ? 'grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out' : 'grid-rows-[0fr]'}`}
    >
      <div className={`min-h-0 overflow-hidden bg-white border-slate-200/60 ${showHeader ? 'border-b' : ''}`}>
        {/* Top row: navigation and actions */}
        <div className="px-4 py-2 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-600 -ml-2 hover:bg-slate-100/50">
              <ArrowLeft size={20} className="mr-1" /> Close
            </Button>
            {/* Meaning position indicator - shows which card in the group */}
            {itemCount > 1 && (
              <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
                {itemIndex + 1}/{itemCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="plain"
              size="sm"
              onClick={onRefresh}
              className="text-slate-600 hover:bg-slate-100 hover:text-indigo-600"
              title="Refresh with AI"
            >
              <RefreshCw size={18} />
            </Button>
            {isSaved && (
              <Button
                variant="plain"
                size="sm"
                onClick={onDelete}
                className="text-slate-600 hover:bg-slate-100 hover:text-rose-600"
                title="Delete (D)"
              >
                <Trash2 size={18} />
              </Button>
            )}
            {!isSaved && (
              <Button
                variant="plain"
                size="sm"
                onClick={onSave}
                className="gap-1.5 border border-transparent text-slate-600 hover:bg-slate-100"
              >
                <Bookmark size={18} />
                <span className="text-xs font-bold">Save</span>
              </Button>
            )}
            {/* Action menu for saved items */}
            {isSaved && (
              <div ref={moreActionsRef} className="relative">
                <Button
                  variant="plain"
                  size="sm"
                  onClick={onToggleActionMenu}
                  className="text-slate-600 hover:bg-slate-100"
                  title="More actions"
                  aria-haspopup="menu"
                  aria-expanded={showActionMenu}
                >
                  <MoreVertical size={18} />
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Bottom row: Progress bar - shown for saved items (word mastery; sentence stats live in the banner) */}
        {stats && (
          <div className="px-4 pb-2">
            <div className="flex items-center gap-2 text-xs">
              <SrsStats srs={stats.srs} mastery={stats.mastery} colors={stats.colors}>
                {showHeader && <LibraryCounts savedItems={savedItems} />}
                <span className="text-slate-300">•</span>
              </SrsStats>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
