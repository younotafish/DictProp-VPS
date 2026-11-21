import type React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { PlannedSet } from '../../services/learningLoop/planner';
import { Chevron } from './TodayPlan';
import type { ThemeRow, ThemesBrowserModel } from './todayModel';

/**
 * One theme: its emoji and title, how many of its sentences are to review and memorized, and a thin bar of the share
 * memorized. A theme with sentences to review is a button that starts a unit from it, or continues the unfinished unit
 * when that holds them all ('in your unit'); one without is a plain row.
 */
function ThemeRowView({ row, onStart, onContinue }: { row: ThemeRow; onStart: (set: PlannedSet) => void; onContinue: () => void }) {
  const share = row.total > 0 ? Math.round((row.memorizedCount / row.total) * 100) : 0;
  const body = (
    <>
      <span className="text-2xl" aria-hidden="true">{row.theme.emoji}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-800">{row.theme.title}</span>
        <span className="block text-xs tabular-nums text-slate-500">
          {row.toReviewCount} to review · {row.memorizedCount} memorized{row.continues ? ' · in your unit' : ''}
        </span>
        <span
          className="mt-1.5 block h-1 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label={`${row.theme.title}: ${row.memorizedCount} of ${row.total} memorized`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
        >
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${share}%` }} />
        </span>
      </span>
    </>
  );
  const set = row.set;
  const button = 'flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50';
  if (row.continues) {
    return (
      <button type="button" onClick={onContinue} aria-label={`Continue your unit from ${row.theme.title}: ${row.toReviewCount} to review`} className={button}>
        {body}
        <Chevron />
      </button>
    );
  }
  if (!set) return <div className="flex min-h-16 items-center gap-3 px-4 py-3 opacity-70">{body}<span className="w-2.5" /></div>;
  return (
    <button
      type="button"
      onClick={() => onStart(set)}
      aria-label={`Start a unit from ${row.theme.title}: ${set.itemIds.length} of ${row.toReviewCount} to review`}
      className={button}
    >
      {body}
      <Chevron />
    </button>
  );
}

export interface ThemesBrowserProps {
  model: ThemesBrowserModel;
  onBack: () => void;
  onStart: (set: PlannedSet) => void;
  /** Continue: the unfinished unit's lesson, from a theme whose sentences to review it holds all of. */
  onContinue: () => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * All themes: each domain with the themes that hold one of Today's sentences, in the taxonomy's order, then Unsorted.
 * A tap on a theme with sentences to review starts a unit from it, or continues the unfinished unit that holds them all;
 * Back, or Esc, returns to the plan.
 */
export function ThemesBrowser({ model, onBack, onStart, onContinue, onScroll }: ThemesBrowserProps) {
  // Unsorted needs no heading of its own: its row says what it is.
  const groups: { key: string; title: string | null; rows: ThemeRow[] }[] = [
    ...model.domains.map(domain => ({ key: domain.id, title: `${domain.emoji} ${domain.title}`, rows: domain.themes })),
    ...(model.unsorted ? [{ key: 'unsorted', title: null, rows: [model.unsorted] }] : []),
  ];
  return (
    <div className="h-full overflow-y-auto bg-slate-50" onScroll={onScroll}>
      <div className="mx-auto max-w-2xl px-4 pb-[calc(var(--nav-h,95px)+1.5rem)] pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <header className="flex items-center gap-2 pb-4 pt-2">
          <button type="button" onClick={onBack} aria-label="Back to Today" className="-ml-2 grid h-11 w-11 place-items-center rounded-full text-slate-500 hover:bg-slate-200">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-2xl font-bold text-slate-800">All themes</h2>
        </header>
        {groups.length === 0 && <p className="px-1 text-sm text-slate-500">No themes yet: they appear as your sentences are sorted.</p>}
        {groups.map(group => (
          <section key={group.key} className="mt-6 first:mt-0" aria-label={group.title ?? 'Unsorted'}>
            {group.title && <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">{group.title}</h3>}
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {group.rows.map(row => <li key={row.themeId ?? 'unsorted'}><ThemeRowView row={row} onStart={onStart} onContinue={onContinue} /></li>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
