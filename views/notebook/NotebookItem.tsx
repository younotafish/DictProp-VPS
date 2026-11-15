import React, { useState, useRef, useEffect } from 'react';
import { Trash2, RefreshCw, Archive, ArchiveRestore, MoreHorizontal } from 'lucide-react';
import type { StoredItem } from '../../types';
import { PronunciationBlock } from '../../components/PronunciationBlock';

interface NotebookItemProps {
  item: StoredItem;
  onDelete: (id: string) => void;
  onViewDetail: () => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  // Senses sharing this spelling; with more than one, the sense label shows
  totalInGroup?: number;
}

export const NotebookItem: React.FC<NotebookItemProps> = React.memo(({
  item, onDelete, onViewDetail, onArchive, onUnarchive, totalInGroup = 1
}) => {
  const [showActions, setShowActions] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  // A mouse press held long enough to open the actions ends in a click, which would close them again.
  const ignoreClicksUntil = useRef(0);
  const LONG_PRESS_MS = 500;
  const MOVE_TOLERANCE_PX = 10;
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusActionsOnOpen = useRef(false);

  const handlePressStart = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    pressStart.current = { x: e.clientX, y: e.clientY };
    longPressFired.current = false;
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressFired.current = true;
      setShowActions(true);
    }, LONG_PRESS_MS);
  };

  const handlePressEnd = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (longPressFired.current) ignoreClicksUntil.current = Date.now() + 400;
    longPressFired.current = false;
    pressStart.current = null;
  };

  // A finger that moves is scrolling or swiping to another meaning, not holding.
  const handlePressMove = (e: React.PointerEvent) => {
    const start = pressStart.current;
    if (start && longPressTimer.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE_PX) {
      handlePressEnd();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // A touch long press can raise the context menu before the timer runs out.
    if (pressStart.current) longPressFired.current = true;
    setShowActions(true);
  };

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  // The more button goes away as the actions open, so the keyboard's focus moves on to the first of them.
  useEffect(() => {
    if (!showActions || !focusActionsOnOpen.current) return;
    focusActionsOnOpen.current = false;
    actionsRef.current?.querySelector('button')?.focus();
  }, [showActions]);

  const handleClick = () => {
    if (Date.now() < ignoreClicksUntil.current) return;
    if (showActions) {
      setShowActions(false);
      return;
    }
    onViewDetail();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    e.preventDefault();
    // The card this opens listens for Enter and Space on window too; it mustn't take this press as well.
    e.stopPropagation();
    handleClick();
  };

  const isPhrase = item.type === 'phrase';
  const title = isPhrase 
    ? (item.data as any).query 
    : (item.data as any).word;
  const subtitle = isPhrase 
    ? (item.data as any).translation 
    : (item.data as any).chinese;
  
  const ipa = isPhrase ? (item.data as any).pronunciation : (item.data as any).ipa;
  const examples = !isPhrase ? (item.data as any).examples : [];
  const history = !isPhrase ? (item.data as any).history : null;
  const sense = !isPhrase ? (item.data as any).sense : null;

  const isDue = (item.srs?.nextReview ?? 0) <= Date.now();
  const intervalDays = Math.round((item.srs?.interval ?? 0) / (24 * 60));

  return (
    <div className="relative overflow-hidden rounded-2xl shadow-sm border border-slate-100 bg-slate-50">
      {/* Main Card — tap or Enter opens it; a long press, right-click or the more button shows its actions */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePressStart}
        onPointerMove={handlePressMove}
        onPointerUp={handlePressEnd}
        onPointerLeave={handlePressEnd}
        onPointerCancel={handlePressEnd}
        onContextMenu={handleContextMenu}
        className="bg-white p-4 relative cursor-pointer select-none [-webkit-touch-callout:none]"
        style={{ touchAction: 'pan-y' }}
      >
        {/* SRS Indicator Strip */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${isDue ? 'bg-orange-400' : (intervalDays > 21 ? 'bg-emerald-400' : 'bg-slate-200')}`}></div>

        <div className="pl-3 pr-2">
          <div className="mb-2 pr-8">
            <h4 className="font-bold text-slate-900 text-lg leading-tight line-clamp-2" title={title}>{title}</h4>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {ipa && (
                <PronunciationBlock 
                  text={title} 
                  ipa={ipa} 
                  className="text-xs py-0.5 px-1.5 min-h-[24px] bg-slate-50 border border-slate-100" 
                />
              )}
              {sense && totalInGroup > 1 && (
                <span className="text-[10px] font-medium text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full truncate max-w-[120px]" title={sense}>
                  {sense}
                </span>
              )}
              {isDue && <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide">Due</span>}
            </div>
          </div>
          <p className="text-sm text-slate-500 truncate mb-2">{subtitle}</p>

          {(examples?.length > 0 || history) && (
            <div className="space-y-2 mt-2 pt-2 border-t border-slate-50">
              {examples?.length > 0 && (
                <div className="text-xs text-slate-600 italic border-l-2 border-indigo-200 pl-2 line-clamp-2">
                  "{(examples[0] || '').replace(/\[\[(.+?)\]\]/g, '$1').replace(/\{\{(.+?)\}\}/g, '$1')}"
                </div>
              )}
              {history && (
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  <span className="font-bold uppercase tracking-wider text-[9px] text-slate-300 mr-1">Origin</span>
                  <span className="line-clamp-2">{history}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!showActions && (
        <button
          onClick={() => { focusActionsOnOpen.current = true; setShowActions(true); }}
          className="absolute top-2 right-2 z-10 w-9 h-9 flex items-center justify-center rounded-full text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label={`More actions for ${title}`}
          title="More actions"
        >
          <MoreHorizontal size={18} />
        </button>
      )}

      {/* Long-press actions */}
      {showActions && (
        <div ref={actionsRef} className="absolute top-3 right-3 flex flex-col gap-2 z-20">
          <button
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('global-search', { detail: { query: title, forceAI: true } })); setShowActions(false); }}
            className="p-2 bg-white text-indigo-500 shadow rounded-full hover:bg-indigo-50 active:scale-95 transition-all"
            title="Refresh with AI (re-run, don't reuse)"
          >
            <RefreshCw size={18} />
          </button>
          {item.isArchived ? (
            onUnarchive && (
              <button 
                onClick={(e) => { e.stopPropagation(); onUnarchive(item.data.id); setShowActions(false); }}
                className="p-2 bg-white text-emerald-500 shadow rounded-full hover:bg-emerald-50 active:scale-95 transition-all"
                title="Unarchive"
              >
                <ArchiveRestore size={18} />
              </button>
            )
          ) : (
            onArchive && (
              <button 
                onClick={(e) => { e.stopPropagation(); onArchive(item.data.id); setShowActions(false); }}
                className="p-2 bg-white text-amber-500 shadow rounded-full hover:bg-amber-50 active:scale-95 transition-all"
                title="Archive"
              >
                <Archive size={18} />
              </button>
            )
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); onDelete(item.data.id); setShowActions(false); }}
            className="p-2 bg-white text-rose-500 shadow rounded-full hover:bg-rose-50 active:scale-95 transition-all"
            title="Delete"
          >
            <Trash2 size={18} />
          </button>
        </div>
      )}
    </div>
  );
});
