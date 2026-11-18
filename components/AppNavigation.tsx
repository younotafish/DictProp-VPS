import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { Book, BookOpenText, CalendarCheck2, Compass, Keyboard, MessageSquareQuote } from 'lucide-react';
import type { StoredItem, ViewState } from '../types';
import { practiceBadge } from '../views/today/practiceBadge';

// The count badges: Sentences' violet, the sentences to review; Today's orange, the practice due, in the colour the
// app gives what's due.
const BADGE_TONES = { violet: 'bg-violet-500', orange: 'bg-orange-500' } as const;

interface NavButtonProps {
  view: ViewState;
  currentView: ViewState;
  onClick: (view: ViewState) => void;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  badge?: number;
  /** The badge's colour, and what a screen reader hears it count: 'Sentences, 3 to review'. */
  badgeTone?: keyof typeof BADGE_TONES;
  badgeNoun?: string;
}

const NavButton: React.FC<NavButtonProps> = ({ view, currentView, onClick, icon: Icon, label, badge, badgeTone = 'violet', badgeNoun = 'to review' }) => (
  <button
    onClick={() => onClick(view)}
    aria-current={currentView === view ? 'page' : undefined}
    aria-label={badge ? `${label}, ${badge} ${badgeNoun}` : undefined}
    className={`relative flex flex-1 flex-col items-center justify-center gap-1 py-3 transition-colors ${currentView === view ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
  >
    <div className="relative">
      <Icon size={24} strokeWidth={currentView === view ? 2.5 : 2} />
      {badge !== undefined && badge > 0 && (
        <span aria-hidden="true" className={`absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full ${BADGE_TONES[badgeTone]} px-1 text-[9px] font-bold leading-none text-white`}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
    <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-wider">{label}</span>
  </button>
);

/**
 * How many practice items are due now (views/today/practiceBadge.ts), counted again when the library changes, when the
 * count next changes with the clock (an item falling due, or midnight) and when the page comes back after sleeping
 * through such a moment. The clock only says when; the count reads the time itself.
 */
function usePracticeDue(items: readonly StoredItem[]): number {
  const [clock, setClock] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- clock is the recount trigger: the count reads the time itself
  const badge = useMemo(() => practiceBadge(items, Date.now()), [items, clock]);
  useEffect(() => {
    const recount = () => setClock(count => count + 1);
    const onVisible = () => { if (document.visibilityState === 'visible') recount(); };
    document.addEventListener('visibilitychange', onVisible);
    // A timer holds at most 2^31 - 1 ms (about 24.8 days); a later change just counts again then.
    const timer = window.setTimeout(recount, Math.min(Math.max(0, badge.changesAt - Date.now()) + 50, 2 ** 31 - 1));
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(timer);
    };
  }, [badge]);
  return badge.due;
}

interface AppNavigationProps {
  currentView: ViewState;
  onNavigate: (view: ViewState) => void;
  sentenceDueCount: number;
  /** The library, whose practice items due today the Today tab's badge counts. */
  items: readonly StoredItem[];
  onKeyboardHelp: () => void;
  /** An open card, popup or dialog covers the bar, so it leaves the tab order and the accessibility tree. */
  covered: boolean;
  /** Keyboard focus reaching the bar while a scroll has hidden it brings the bar back. */
  onFocus: () => void;
}

const AppNavigation = forwardRef<HTMLElement, AppNavigationProps>(({
  currentView,
  onNavigate,
  sentenceDueCount,
  items,
  onKeyboardHelp,
  covered,
  onFocus,
}, ref) => {
  const practiceDue = usePracticeDue(items);
  return (
    // Its height is src/index.css's --nav-h, which the notices and the search button float above: change the padding,
    // the buttons' spacing or their icon and label sizes there too.
    <nav
      ref={ref}
      aria-label="Main"
      inert={covered}
      onFocus={onFocus}
      className="fixed bottom-0 left-0 right-0 z-30 flex translate-y-0 justify-between bg-white px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-1 transition-transform duration-300"
    >
      <NavButton view="notebook" currentView={currentView} onClick={onNavigate} icon={Book} label="Notebook" />
      <NavButton view="sentences" currentView={currentView} onClick={onNavigate} icon={MessageSquareQuote} label="Sentences" badge={sentenceDueCount || undefined} />
      <NavButton view="real-life" currentView={currentView} onClick={onNavigate} icon={Compass} label="Real Life" />
      <NavButton view="essays" currentView={currentView} onClick={onNavigate} icon={BookOpenText} label="Essays" />
      <NavButton
        view="study"
        currentView={currentView}
        onClick={onNavigate}
        icon={CalendarCheck2}
        label="Today"
        badge={practiceDue || undefined}
        badgeTone="orange"
        badgeNoun="to practice"
      />
      <button
        onClick={onKeyboardHelp}
        className="hidden flex-col items-center justify-center gap-1 py-3 text-slate-300 transition-colors hover:text-slate-500 md:flex"
        title="Gestures & shortcuts (?)"
        aria-label="Gestures & shortcuts"
      >
        <Keyboard size={20} strokeWidth={2} />
        <span className="text-[10px] font-bold uppercase tracking-wider">?</span>
      </button>
    </nav>
  );
});

AppNavigation.displayName = 'AppNavigation';

export default AppNavigation;
