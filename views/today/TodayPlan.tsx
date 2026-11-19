import type React from 'react';
import { Brain, Flame, GalleryVerticalEnd, Loader2, Play, Speech, Target, WifiOff } from 'lucide-react';
import type { LoopMode } from '../../services/learningLoop/cues';
import type { PlannedSet } from '../../services/learningLoop/planner';
import { DAILY_SET_GOAL, type LoopProgress } from '../../services/learningLoop/stats';
import { formatPlanDate, sentenceCount, type PlanCardModel, type SetRow, type ThemeLabel } from './todayModel';

const EYEBROW = 'text-xs font-bold uppercase tracking-[0.18em] text-slate-400';

/** The › that ends a row which opens something: a glyph, as the plan's copy writes it ('All themes ›'). */
export const Chevron = ({ className = 'text-slate-300' }: { className?: string }) => (
  <span aria-hidden="true" className={`shrink-0 text-xl leading-none ${className}`}>›</span>
);

/** The day's goal as a ring: how many new sentences were met in sets today, of DAILY_SET_GOAL. */
export function GoalRing({ count, size = 48 }: { count: number | null; size?: number }) {
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const share = count === null ? 0 : Math.min(count, DAILY_SET_GOAL) / DAILY_SET_GOAL;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={count === null ? 'Today’s goal: loading' : `Today’s goal: ${count} of ${DAILY_SET_GOAL} new sentences met`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth="4" className="stroke-slate-200" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-indigo-600"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - share)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-bold tabular-nums text-slate-800" aria-hidden="true">
        {count === null ? '—' : count}/{DAILY_SET_GOAL}
      </span>
    </div>
  );
}

/** Days in a row that met the goal: an orange flame, grey at 0, '—' until the history and the set days are in. */
function Streak({ streak }: { streak: number | null }) {
  const label = streak === null ? 'Streak: loading' : `${streak}-day streak`;
  return (
    <div className="flex items-center gap-1" role="img" aria-label={label}>
      <Flame size={20} aria-hidden="true" className={streak ? 'text-orange-500' : 'text-slate-300'} />
      <span className="text-lg font-bold tabular-nums text-slate-800" aria-hidden="true">{streak ?? '—'}</span>
    </div>
  );
}

/** One status row of the plan card: an icon and a line. Display only. */
function StatusRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex min-h-8 items-center gap-3 text-[15px] leading-snug text-slate-700">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100" aria-hidden="true">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

const done = <span className="text-base font-bold text-emerald-600">✓</span>;

function setRowContent(row: SetRow): { icon: React.ReactNode; text: React.ReactNode } {
  switch (row.kind) {
    case 'met': return { icon: done, text: <span className="font-semibold text-emerald-700">{row.count} today</span> };
    case 'practice-first': return { icon: <Target size={16} className="text-orange-600" />, text: <><span className="font-semibold text-slate-800">Practice first</span> · {row.due} due</> };
    case 'set': return {
      icon: <span className="text-base">{row.theme.emoji}</span>,
      text: <><span className="font-semibold text-slate-800">Set</span> · {row.theme.title} · <span className="tabular-nums">{row.size}</span></>,
    };
    case 'sorting': return { icon: <Loader2 size={16} className="animate-spin text-indigo-500" />, text: <>Sorting your sentences into themes… <span className="tabular-nums">{row.percent}%</span></> };
    case 'loading': return { icon: <Loader2 size={16} className="animate-spin text-slate-400" />, text: <span className="text-slate-500">Loading themes…</span> };
    case 'offline': return { icon: <WifiOff size={16} className="text-slate-400" />, text: <span className="text-slate-500">Themes load when you’re online.</span> };
    case 'empty': return { icon: done, text: <span className="text-slate-500">No new sentences left in your themes</span> };
  }
}

/** Speak or Quiet, per device: a segmented control whose caption says what the mode asks for. */
export function ModeSwitch({ mode, onChange }: { mode: LoopMode; onChange: (mode: LoopMode) => void }) {
  const option = (value: LoopMode, label: string, Icon: typeof Speech) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => onChange(value)}
      className={`inline-flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors ${mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
    >
      <Icon size={16} aria-hidden="true" /> {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div role="radiogroup" aria-label="Practice mode" className="inline-flex rounded-xl bg-slate-100 p-1">
        {option('speak', 'Speak', Speech)}
        {option('quiet', 'Quiet', Brain)}
      </div>
      <p className="text-xs text-slate-500">
        {/* Practice earns Can say it only aloud; meeting a sentence you already say in daily life is your call in either. */}
        {mode === 'speak' ? 'Say each answer aloud' : 'Think each answer · quiet practice never earns Can say it'}
      </p>
    </div>
  );
}

export interface TodayPlanProps {
  now: number;
  card: PlanCardModel;
  /** The plan's next set, which Start set starts. */
  next: PlannedSet | null;
  mode: LoopMode;
  onModeChange: (mode: LoopMode) => void;
  /** Today's count and the streak; null until the history (and, for the streak, the set days) has loaded. */
  todayCount: number | null;
  streak: number | null;
  /** The three sets after the next one, each with its theme. */
  upNext: readonly { set: PlannedSet; theme: ThemeLabel }[];
  /** Whether the themes browser has anything to list. */
  hasThemes: boolean;
  progress: LoopProgress;
  /** Sentences decided by a triage choice this week; null until the history has loaded. */
  sortedThisWeek: number | null;
  /** The server's sorting, while it still has sentences to sort and the set row doesn't already say so. */
  sorting: { percent: number; error?: string } | null;
  /** Classic Study's due count, and whether a classic session waits to be taken up. */
  classicDue: number;
  classicResumable: boolean;
  /** A set or practice session kept from before, not on screen (classic Study's was newer): 'Resume …'. */
  resumeLabel: string | null;
  onPractice: () => void;
  onStartSet: (set: PlannedSet) => void;
  onResume: () => void;
  onThemes: () => void;
  onClassic: () => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * Today's plan (DESIGN-v2 §8): the date, the streak and the goal ring; the plan card with its two status rows, the
 * one primary button and the Speak | Quiet switch; the sets up next and the themes browser; the progress line; and
 * Card review. It draws what the host computed, and computes nothing that depends on the library.
 */
export function TodayPlan(props: TodayPlanProps) {
  const { card, next, upNext, progress } = props;
  const practiceRow = card.practice.kind === 'due'
    ? { icon: <Target size={16} className="text-orange-600" />, text: <><span className="font-semibold text-slate-800">Practice</span> · <span className="tabular-nums">{card.practice.due}</span> due</> }
    : card.practice.kind === 'done'
      ? { icon: done, text: <span className="font-semibold text-emerald-700">Practiced</span> }
      : { icon: <Target size={16} className="text-slate-400" />, text: <span className="text-slate-500">Nothing to practice yet</span> };
  const setRow = setRowContent(card.set);
  const { action } = card;
  return (
    <div className="h-full overflow-y-auto bg-slate-50" onScroll={props.onScroll}>
      <div className="mx-auto max-w-2xl px-4 pb-[calc(var(--nav-h,95px)+1.5rem)] pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <header className="flex items-center justify-between gap-4 pb-5 pt-4">
          <div className="min-w-0">
            <h2 className="text-3xl font-bold text-slate-800">Today</h2>
            <p className="mt-0.5 text-sm text-slate-500">{formatPlanDate(props.now)}</p>
          </div>
          <div className="flex items-center gap-4">
            <Streak streak={props.streak} />
            <GoalRing count={props.todayCount} />
          </div>
        </header>

        {props.resumeLabel && (
          <button
            type="button"
            onClick={props.onResume}
            className="mb-3 flex min-h-14 w-full items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 text-left text-indigo-800 hover:bg-indigo-100"
          >
            <Play size={18} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-semibold">{props.resumeLabel}</span>
            <Chevron className="text-indigo-400" />
          </button>
        )}

        <section aria-label="Today’s plan" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <ul className="space-y-2">
            <StatusRow icon={practiceRow.icon}>{practiceRow.text}</StatusRow>
            <StatusRow icon={setRow.icon}>{setRow.text}</StatusRow>
          </ul>
          {action.kind === 'practice' && (
            <button type="button" onClick={props.onPractice} aria-keyshortcuts="Enter" className="mt-4 h-14 w-full rounded-xl bg-indigo-600 font-semibold text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700">
              Practice {action.count}
            </button>
          )}
          {action.kind === 'set' && next && (
            <button type="button" onClick={() => props.onStartSet(next)} aria-keyshortcuts="Enter" className="mt-4 h-14 w-full rounded-xl bg-indigo-600 font-semibold text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700">
              Start set
            </button>
          )}
          {action.kind === 'done' && (
            <p role="status" className="mt-4 grid h-14 w-full place-items-center rounded-xl bg-emerald-50 font-semibold text-emerald-700">
              Done for today ✓
            </p>
          )}
          {card.another && (
            <button
              type="button"
              onClick={() => props.onStartSet(card.another!.set)}
              className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-indigo-600 hover:bg-indigo-50"
            >
              Another set: <span aria-hidden="true">{card.another.theme.emoji}</span> {card.another.theme.title}
            </button>
          )}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <ModeSwitch mode={props.mode} onChange={props.onModeChange} />
          </div>
        </section>

        {props.sorting && (card.set.kind !== 'sorting' || props.sorting.error) && (
          <div className="mt-3 px-1 text-xs text-slate-500" role="status">
            {card.set.kind !== 'sorting' && (
              <p className="flex items-center gap-1.5">
                <Loader2 size={13} aria-hidden="true" className="animate-spin text-indigo-500" />
                Sorting your sentences into themes… <span className="tabular-nums">{props.sorting.percent}%</span>
              </p>
            )}
            {props.sorting.error && <p className="mt-1 text-rose-700">{props.sorting.error}</p>}
          </div>
        )}

        {(upNext.length > 0 || props.hasThemes) && (
          <section className="mt-7" aria-labelledby="today-up-next">
            <div className="flex items-center justify-between">
              <h3 id="today-up-next" className={EYEBROW}>Up next</h3>
              {props.hasThemes && (
                <button type="button" onClick={props.onThemes} className="-my-2 inline-flex h-11 items-center gap-0.5 text-sm font-semibold text-indigo-600 hover:text-indigo-800">
                  All themes <Chevron className="text-indigo-400" />
                </button>
              )}
            </div>
            {upNext.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {upNext.map(({ set, theme }) => (
                  <li key={set.themeId ?? 'unsorted'}>
                    <button
                      type="button"
                      onClick={() => props.onStartSet(set)}
                      aria-label={`Start set: ${theme.title}, ${sentenceCount(set.itemIds.length)}`}
                      className="flex h-14 w-full items-center gap-3 px-4 text-left hover:bg-slate-50"
                    >
                      <span className="text-xl" aria-hidden="true">{theme.emoji}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{theme.title}</span>
                      <span className="text-sm tabular-nums text-slate-500">{set.itemIds.length}</span>
                      <Chevron />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="mt-7" aria-labelledby="today-progress">
          <h3 id="today-progress" className={EYEBROW}>Progress</h3>
          <div className="mt-2 grid grid-cols-3 divide-x divide-slate-100 rounded-2xl border border-slate-200 bg-white py-4 text-center">
            <div className="px-2">
              <p className="text-2xl font-bold tabular-nums text-emerald-700">{progress.sayable}</p>
              <p className="text-sm text-slate-500">Can say</p>
              <p className="text-xs tabular-nums text-emerald-700">+{progress.sayableThisWeek} this week</p>
            </div>
            <div className="px-2">
              <p className="text-2xl font-bold tabular-nums text-slate-900">{progress.practicing}</p>
              <p className="text-sm text-slate-500">Practicing</p>
            </div>
            <div className="px-2">
              <p className="text-2xl font-bold tabular-nums text-slate-900">{progress.tomorrow}</p>
              <p className="text-sm text-slate-500">Tomorrow</p>
              <p className="text-xs text-slate-400">to practice</p>
            </div>
          </div>
          <p className="mt-2 px-1 text-xs tabular-nums text-slate-500">
            This week: saved {progress.savedThisWeek} · sorted {props.sortedThisWeek ?? '—'}
          </p>
        </section>

        <button
          type="button"
          onClick={props.onClassic}
          className="mt-7 flex h-14 w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 text-left hover:bg-slate-50"
        >
          <GalleryVerticalEnd size={18} aria-hidden="true" className="text-slate-400" />
          <span className="flex-1 font-medium text-slate-800">Card review</span>
          <span className="text-sm tabular-nums text-slate-500">{props.classicResumable ? 'Resume' : `${props.classicDue} due`}</span>
          <Chevron />
        </button>
      </div>
    </div>
  );
}
