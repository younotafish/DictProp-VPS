import type React from 'react';
import { Flame, GalleryVerticalEnd, Loader2, WifiOff } from 'lucide-react';
import type { PlannedSet } from '../../services/learningLoop/planner';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats';
import { formatPlanDate, sentenceCount, type PlanCardModel, type ThemeLabel } from './todayModel';

const EYEBROW = 'text-xs font-bold uppercase tracking-[0.18em] text-slate-400';
const PRIMARY = 'mt-4 h-14 w-full rounded-xl bg-indigo-600 font-semibold text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700';

/** The › that ends a row which opens something: a glyph, as the plan's copy writes it ('All themes ›'). */
export const Chevron = ({ className = 'text-slate-300' }: { className?: string }) => (
  <span aria-hidden="true" className={`shrink-0 text-xl leading-none ${className}`}>›</span>
);

/** The day's goal as a ring: how many sentences were reviewed in units today, of DAILY_SET_GOAL. */
function GoalRing({ count, size = 48 }: { count: number | null; size?: number }) {
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const share = count === null ? 0 : Math.min(count, DAILY_SET_GOAL) / DAILY_SET_GOAL;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={count === null ? 'Today’s goal: loading' : `Today’s goal: ${count} of ${DAILY_SET_GOAL} sentences reviewed`}
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

/** A status line of the unit card: an icon and a line. Display only. */
function StatusRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex min-h-8 items-center gap-3 text-[15px] leading-snug text-slate-700">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100" aria-hidden="true">{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

const check = <span className="text-base font-bold text-emerald-600">✓</span>;

/** The unit a card offers: its theme under the Unit eyebrow, how many sentences it holds, and how many are memorized. */
function UnitHeading({ theme, size, memorized }: { theme: ThemeLabel; size: number; memorized?: number }) {
  return (
    <>
      <p className={EYEBROW}>Unit</p>
      <div className="mt-2 flex items-center gap-3">
        <span className="text-3xl leading-none" aria-hidden="true">{theme.emoji}</span>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-bold text-slate-800">{theme.title}</h3>
          <p className="text-sm tabular-nums text-slate-500">
            {sentenceCount(size)}{memorized === undefined ? '' : ` · ${memorized} memorized`}
          </p>
        </div>
      </div>
    </>
  );
}

/** Why the card offers no unit. */
function noUnitRow(card: Extract<PlanCardModel, { kind: 'sorting' | 'loading' | 'offline' | 'empty' }>): { icon: React.ReactNode; text: React.ReactNode } {
  switch (card.kind) {
    case 'sorting': return { icon: <Loader2 size={16} className="animate-spin text-indigo-500" />, text: <>Sorting your sentences into themes… <span className="tabular-nums">{card.percent}%</span></> };
    case 'loading': return { icon: <Loader2 size={16} className="animate-spin text-slate-400" />, text: <span className="text-slate-500">Loading themes…</span> };
    case 'offline': return { icon: <WifiOff size={16} className="text-slate-400" />, text: <span className="text-slate-500">Themes load when you’re online.</span> };
    case 'empty': return { icon: check, text: <span className="text-slate-500">Nothing to review in your themes</span> };
  }
}

/** The unit card in its state (todayModel.ts planCardModel). */
function UnitCard({ card, onContinue, onStartUnit }: { card: PlanCardModel; onContinue: () => void; onStartUnit: (set: PlannedSet) => void }) {
  switch (card.kind) {
    case 'continue': {
      const share = card.size > 0 ? Math.round((card.memorized / card.size) * 100) : 0;
      return (
        <>
          <UnitHeading theme={card.theme} size={card.size} memorized={card.memorized} />
          <span
            className="mt-3 block h-1.5 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-label={`${card.theme.title}: ${card.memorized} of ${card.size} memorized`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
          >
            <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${share}%` }} />
          </span>
          <button type="button" onClick={onContinue} aria-keyshortcuts="Enter" className={PRIMARY}>Continue</button>
        </>
      );
    }
    case 'start':
      return (
        <>
          <UnitHeading theme={card.theme} size={card.size} />
          <button type="button" onClick={() => onStartUnit(card.set)} aria-keyshortcuts="Enter" className={PRIMARY}>Start unit</button>
        </>
      );
    case 'done': {
      const { finished, another } = card;
      return (
        <>
          <p role="status" className="grid h-14 w-full place-items-center rounded-xl bg-emerald-50 font-semibold text-emerald-700">
            Done for today ✓
          </p>
          {finished && (
            <div className="mt-3 px-1">
              <StatusRow icon={check}>
                <span aria-hidden="true">{finished.theme.emoji}</span> <span className="font-semibold text-slate-800">{finished.theme.title}</span>
                {' · '}<span className="tabular-nums">{finished.memorized} memorized</span>
              </StatusRow>
            </div>
          )}
          {another && (
            <button
              type="button"
              onClick={() => onStartUnit(another.set)}
              className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-indigo-600 hover:bg-indigo-50"
            >
              Another unit: <span aria-hidden="true">{another.theme.emoji}</span> {another.theme.title}
            </button>
          )}
        </>
      );
    }
    default: {
      const row = noUnitRow(card);
      return <StatusRow icon={row.icon}>{row.text}</StatusRow>;
    }
  }
}

export interface TodayPlanProps {
  now: number;
  card: PlanCardModel;
  /** Today's count and the streak; null until the history (and, for the streak, the set days) has loaded. */
  todayCount: number | null;
  streak: number | null;
  /** Up to three units after the one the card offers, each with its theme (todayModel.ts upNextUnits). */
  upNext: readonly { set: PlannedSet; theme: ThemeLabel }[];
  /** Whether the themes browser has anything to list. */
  hasThemes: boolean;
  /** The server's sorting, while it still has sentences to sort and the card doesn't already say so. */
  sorting: { percent: number; error?: string } | null;
  /** Classic Study's due count, and whether a classic session waits to be taken up. */
  classicDue: number;
  classicResumable: boolean;
  /** Continue: the unfinished unit's lesson, at its first sentence still to review. */
  onContinue: () => void;
  /** Starts a unit: Start unit, Another unit, or a row of Up next. */
  onStartUnit: (set: PlannedSet) => void;
  onThemes: () => void;
  onClassic: () => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * Today's plan: the date, the streak and the goal ring; the unit card with its one primary button; the units up next
 * and the themes browser; and Card review. It draws what the host computed, and computes nothing that depends on the
 * library.
 */
export function TodayPlan(props: TodayPlanProps) {
  const { card, upNext } = props;
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

        <section aria-label="Today’s unit" className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <UnitCard card={card} onContinue={props.onContinue} onStartUnit={props.onStartUnit} />
        </section>

        {props.sorting && (card.kind !== 'sorting' || props.sorting.error) && (
          <div className="mt-3 px-1 text-xs text-slate-500" role="status">
            {card.kind !== 'sorting' && (
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
                {/* A theme can come round twice, but no sentence is in two units, so a unit's first sentence keys it. */}
                {upNext.map(({ set, theme }) => (
                  <li key={set.itemIds[0] ?? set.themeId ?? 'unsorted'}>
                    <button
                      type="button"
                      onClick={() => props.onStartUnit(set)}
                      aria-label={`Start unit: ${theme.title}, ${sentenceCount(set.itemIds.length)}`}
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
