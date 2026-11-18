import { Play, Undo2, X } from 'lucide-react';
import type { PracticeSummary, SetSummary } from '../../services/learningLoop/session';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats';
import { GoalRing } from './TodayPlan';
import type { SummaryAction, ThemeLabel } from './todayModel';

const PRIMARY = 'h-14 w-full rounded-xl bg-indigo-600 font-semibold text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700';
const SECONDARY = 'h-12 w-full rounded-xl border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-100';

/** Three numbers side by side, each with its caption, in the colour of what it counts. */
function Counts({ counts }: { counts: readonly { label: string; value: number; tone: string }[] }) {
  return (
    <div className="mt-6 grid grid-cols-3 divide-x divide-slate-100 rounded-2xl border border-slate-200 bg-white py-5 text-center">
      {counts.map(({ label, value, tone }) => (
        <div key={label} className="px-2">
          <p className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
          <p className="text-sm text-slate-500">{label}</p>
        </div>
      ))}
    </div>
  );
}

const actionLabel = (action: SummaryAction): string =>
  action.kind === 'practice' ? `Practice ${action.count} more`
    : action.kind === 'set' ? `${action.label}: ${action.theme.emoji} ${action.theme.title}`
      : 'Done';

export interface LoopSummaryProps {
  /** The set's theme, or null for a practice session. */
  theme: ThemeLabel | null;
  /** 'Set complete · 14 met', 'Ended early · 6 of 14 met', 'Practice complete · 20 items'. */
  headline: string;
  set?: SetSummary;
  practice?: PracticeSummary;
  /** The items this practice made ones you can say, by name. */
  graduated: readonly string[];
  /** Practice due by the end of tomorrow. */
  tomorrow: number;
  /** Today's count toward the goal; null until the history has loaded. */
  todayCount: number | null;
  /** The buttons, the primary first (todayModel.ts summaryActions). */
  actions: readonly SummaryAction[];
  canUndo: boolean;
  undoing: boolean;
  undoError: string;
  onUndo: () => void;
  /** Resume, for a session ended early with a card left. */
  onResume?: () => void;
  onAction: (action: SummaryAction) => void;
  onClose: () => void;
}

/**
 * The end of a set or a practice session (DESIGN-v2 §6). A set's: how many items you can say, keep passive and now
 * practice, and how its round went. A practice session's: how many came on the first try, with a hint or not yet, the
 * recall rate, and the items it made ones you can say. Both: today's goal and tomorrow's practice, an undo for the last
 * answer, Resume for a session ended early, and what to do next, the primary first.
 */
export function LoopSummary(props: LoopSummaryProps) {
  const { set, practice, actions } = props;
  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-xl px-5 pb-[calc(var(--nav-h,95px)+1.5rem)] pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
              {props.theme ? <><span aria-hidden="true">{props.theme.emoji}</span> {props.theme.title}</> : 'Practice'}
            </p>
            <h2 className="mt-1 text-2xl font-bold text-slate-800">{props.headline}</h2>
          </div>
          <button type="button" onClick={props.onClose} className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="Close the summary">
            <X size={20} />
          </button>
        </div>

        {set && (
          <>
            <Counts counts={[
              { label: 'Can say', value: set.sayable, tone: 'text-emerald-700' },
              { label: 'Passive', value: set.passive, tone: 'text-slate-800' },
              { label: 'Practicing', value: set.practicing, tone: 'text-amber-700' },
            ]} />
            {set.rounded > 0 && (
              <p className="mt-4 text-sm text-slate-600">
                Round: <span className="font-semibold tabular-nums text-slate-800">{set.firstTry} of {set.rounded}</span> on the first try
              </p>
            )}
          </>
        )}

        {practice && (
          <>
            <Counts counts={[
              { label: 'First try', value: practice.firstTry, tone: 'text-emerald-700' },
              { label: 'With a hint', value: practice.withHint, tone: 'text-amber-700' },
              { label: 'Not yet', value: practice.notYet, tone: 'text-rose-700' },
            ]} />
            {practice.recallRate !== null && (
              <p className="mt-4 text-sm text-slate-600">
                Recall: <span className="font-semibold tabular-nums text-slate-800">{practice.recallRate}%</span> on the first try
              </p>
            )}
            {props.graduated.length > 0 && (
              <section className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <h3 className="text-sm font-semibold text-emerald-800">Can say it now</h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {props.graduated.map(word => (
                    <li key={word} className="rounded-full bg-white px-2.5 py-1 text-sm text-emerald-800">{word}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <div className="mt-6 flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4">
          <GoalRing count={props.todayCount} />
          <div className="min-w-0">
            <p className="font-semibold text-slate-800">
              <span className="tabular-nums">{props.todayCount ?? '—'}</span> of {DAILY_SET_GOAL} new items today
            </p>
            <p className="text-sm text-slate-500">Tomorrow: <span className="tabular-nums">{props.tomorrow}</span> to practice</p>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          {props.canUndo && (
            <button type="button" onClick={props.onUndo} disabled={props.undoing} aria-keyshortcuts="U" className={`${SECONDARY} inline-flex items-center justify-center gap-2 disabled:opacity-60`}>
              <Undo2 size={18} aria-hidden="true" /> {props.undoing ? 'Undoing…' : 'Undo last answer'}
            </button>
          )}
          {props.undoError && <p className="text-sm text-rose-700" role="alert">{props.undoError}</p>}
          {props.onResume && (
            <button type="button" onClick={props.onResume} aria-keyshortcuts="R" className={`${SECONDARY} inline-flex items-center justify-center gap-2`}>
              <Play size={18} aria-hidden="true" /> Resume
            </button>
          )}
          {actions.map((action, index) => (
            <button
              key={action.kind}
              type="button"
              onClick={() => props.onAction(action)}
              aria-keyshortcuts={index === 0 ? 'Enter' : undefined}
              className={index === 0 ? PRIMARY : SECONDARY}
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
