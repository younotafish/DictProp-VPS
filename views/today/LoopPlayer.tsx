import { useLayoutEffect } from 'react';
import { Brain, Eye, Repeat2, Speech, X } from 'lucide-react';
import type { MeetChoice } from '../../services/learningLoop/session';
import { TAB_FOOTER_HEIGHT } from '../../components/study/StudyCard';
import { LoopCardFace, type LoopCardFaceProps } from './LoopCardFace';
import { MEET_CHOICES, type LoopReceipt, type LoopTone, type RunCaptions, type ThemeLabel } from './todayModel';
import type { TodayFooter } from './todayKeys';

const TONE_TEXT: Record<LoopTone, string> = {
  amber: 'text-amber-700', slate: 'text-slate-700', emerald: 'text-emerald-700', rose: 'text-rose-700',
};
const TONE_BUTTON: Record<LoopTone, string> = {
  amber: 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
  slate: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
  emerald: 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
  rose: 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100',
};
const PRIMARY = 'h-14 rounded-xl bg-indigo-600 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center justify-center gap-2';
const SECONDARY = 'h-14 rounded-xl border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center justify-center gap-2';
const MEET_KEYS: Record<MeetChoice, string> = { practice: '1 ArrowLeft', passive: '2 ArrowDown', say: '3 ArrowRight' };

/** The line above the footer's buttons: the review Undo (Back, in the Meet) would take back, or why an undo failed. */
function ReceiptLine({ receipt, undoLabel, canUndo, undoing, waiting, error, onUndo }: {
  receipt: LoopReceipt | null;
  undoLabel: 'Undo' | 'Back';
  canUndo: boolean;
  undoing: boolean;
  waiting: boolean;
  error: string;
  onUndo: () => void;
}) {
  const detail = undoing ? 'Undoing…' : [receipt?.detail, waiting ? 'saved on this device' : ''].filter(Boolean).join(' · ');
  return (
    <div className="flex h-8 items-center gap-2 text-xs text-slate-500">
      <div className="min-w-0 flex-1 truncate" aria-live="polite">
        {error ? <span className="text-rose-700" role="alert">{error}</span> : receipt && (
          <>
            <span aria-hidden="true">↶ </span>{receipt.word} · <span className={TONE_TEXT[receipt.tone]}>{receipt.label}</span>
            {detail && ` · ${detail}`}
          </>
        )}
      </div>
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          className="-my-1.5 h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-indigo-600 hover:bg-slate-200 disabled:opacity-50"
          aria-label={undoLabel === 'Back' ? 'Back: take back the last choice' : 'Undo the last answer'}
          aria-keyshortcuts="U"
        >
          {undoLabel}
        </button>
      )}
    </div>
  );
}

export interface LoopPlayerProps extends LoopCardFaceProps {
  /** The set's theme, or null for a practice session. */
  theme: ThemeLabel | null;
  /** The header's 'i / n', and in which part of the session. */
  position: number;
  total: number;
  phase: 'meet' | 'round' | 'practice';
  onToggleMode: () => void;
  footer: TodayFooter;
  /** The hint can still be taken on this cue. */
  canHint: boolean;
  /** Can say it is open (the Meet closes it once the hint has shown). */
  sayOpen: boolean;
  /** A run card's captions under Not yet and Got it. */
  captions: RunCaptions | null;
  receipt: LoopReceipt | null;
  undoLabel: 'Undo' | 'Back';
  canUndo: boolean;
  undoing: boolean;
  /** The receipt's review is still in the outbox, not yet on the server. */
  waiting: boolean;
  undoError: string;
  onClose: () => void;
  /** The footer's buttons, which ignore a tap within 350 ms of the last reveal or answer (acceptFooterTap). */
  onReveal: () => void;
  onHint: () => void;
  onChoose: (choice: MeetChoice) => void;
  onAnswer: (gotIt: boolean) => void;
  onNext: () => void;
  onReplay: () => void;
  onUndo: () => void;
}

/**
 * A set or practice session's card (DESIGN-v2 §8): the header with × to end, the theme or 'Practice', 'i / n', a thin
 * progress bar and the Speak | Quiet chip; the card (LoopCardFace); and the footer, fixed above the tab bar, with the
 * receipt line and one 56 px slot that holds Hint and Reveal, the Meet's three choices, Not yet and Got it, or Next,
 * so nothing under the thumb changes place.
 */
export function LoopPlayer(props: LoopPlayerProps) {
  // The page's notices and the search button float above the footer while a card shows; hiding the tab clears it too.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--tab-footer-h', TAB_FOOTER_HEIGHT);
    return () => { root.removeProperty('--tab-footer-h'); };
  }, []);

  const { footer, undoing, mode, phase, theme } = props;
  const share = props.total > 0 ? Math.min(1, (props.position - 1) / props.total) : 0;
  const ModeIcon = mode === 'speak' ? Speech : Brain;
  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="shrink-0 px-4 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="-ml-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-200"
            aria-label={theme ? 'End the set' : 'End practice'}
          >
            <X size={20} />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
            {theme ? <><span aria-hidden="true">{theme.emoji}</span> {theme.title}</> : 'Practice'}
          </p>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-500">
            {phase === 'round' ? 'Round ' : ''}{props.position} / {props.total}
          </span>
          <button
            type="button"
            onClick={props.onToggleMode}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-slate-600 hover:bg-slate-200"
            aria-label={mode === 'speak' ? 'Speak mode: switch to Quiet' : 'Quiet mode: switch to Speak'}
          >
            <ModeIcon size={16} aria-hidden="true" /> {mode === 'speak' ? 'Speak' : 'Quiet'}
          </button>
        </div>
        <div
          className="mx-auto h-1 max-w-2xl overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-label="Session progress"
          aria-valuemin={0}
          aria-valuemax={props.total}
          aria-valuenow={Math.max(0, props.position - 1)}
        >
          <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-300" style={{ width: `${share * 100}%` }} />
        </div>
      </header>

      {/* Each card starts scrolled to its top; a long answer scrolls here while the footer stays put. */}
      <section key={`${phase}:${props.position}`} className="min-h-0 flex-1 overflow-y-auto px-4">
        <LoopCardFace {...props} />
      </section>

      <footer className="shrink-0 px-4 pb-[calc(var(--nav-h,95px)+0.5rem)]">
        <div className="mx-auto max-w-2xl border-t border-slate-200">
          <ReceiptLine
            receipt={props.receipt}
            undoLabel={props.undoLabel}
            canUndo={props.canUndo}
            undoing={undoing}
            waiting={props.waiting}
            error={props.undoError}
            onUndo={props.onUndo}
          />
          {footer === 'cue' && (
            <div className="mt-1.5 grid grid-cols-[1fr_2fr] gap-2">
              <button type="button" onClick={props.onHint} disabled={undoing || !props.canHint} className={SECONDARY} aria-keyshortcuts="H">
                {props.canHint ? 'Hint' : 'Hint shown'}
              </button>
              <button type="button" onClick={props.onReveal} disabled={undoing} className={PRIMARY} aria-keyshortcuts="Space Enter">
                <Eye size={18} aria-hidden="true" /> Reveal
              </button>
            </div>
          )}
          {footer === 'meet' && (
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {MEET_CHOICES.map(({ choice, label, tone }) => {
                const closed = choice === 'say' && !props.sayOpen;
                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => { if (!closed) props.onChoose(choice); }}
                    disabled={undoing}
                    aria-disabled={closed || undefined}
                    aria-label={closed ? 'Can say it is closed after a hint' : undefined}
                    aria-keyshortcuts={closed ? undefined : MEET_KEYS[choice]}
                    className={`h-14 rounded-xl border px-1 text-[15px] font-semibold disabled:opacity-50 ${TONE_BUTTON[tone]} ${closed ? 'cursor-not-allowed opacity-40 hover:bg-emerald-50' : ''}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {footer === 'run' && props.captions && (
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => props.onAnswer(false)} disabled={undoing} className={`h-14 rounded-xl border font-semibold disabled:opacity-50 ${TONE_BUTTON.rose}`} aria-keyshortcuts="1">
                <span className="block">Not yet</span>
                <span className="block text-[11px] font-normal opacity-75">{props.captions.notYet}</span>
              </button>
              <button type="button" onClick={() => props.onAnswer(true)} disabled={undoing} className={`h-14 rounded-xl border font-semibold disabled:opacity-50 ${TONE_BUTTON.emerald}`} aria-keyshortcuts="3 Enter">
                <span className="block">Got it</span>
                <span className="block text-[11px] font-normal opacity-75">{props.captions.gotIt}</span>
              </button>
            </div>
          )}
          {footer === 'encode' && (
            <div className="mt-1.5 grid grid-cols-[1fr_2fr] gap-2">
              <button type="button" onClick={props.onReplay} disabled={undoing} className={SECONDARY} aria-keyshortcuts="P">
                <Repeat2 size={18} aria-hidden="true" /> Replay
              </button>
              <button type="button" onClick={props.onNext} disabled={undoing} className={PRIMARY} aria-keyshortcuts="Space Enter">Next</button>
            </div>
          )}
          {footer === 'look' && (
            <div className="mt-1.5 grid">
              <button type="button" onClick={props.onNext} disabled={undoing} className={PRIMARY} aria-keyshortcuts="Space Enter">Next</button>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
