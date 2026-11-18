import { isSentenceItem, isVocabItem, type ReviewRating, type SentenceData, type StoredItem } from '../../types';
import { THEME_DOMAINS, themeById } from '../../server/src/shared/item-themes';
import type { LoopCard } from '../../services/learningLoop/cues';
import type { LoopPlan, PlannedSet, ThemePlan } from '../../services/learningLoop/planner';
import {
  attemptStage,
  currentItemId,
  runOf,
  PRACTICE_SESSION_CAP,
  type AttemptOutcome,
  type LoopSession,
  type MeetChoice,
} from '../../services/learningLoop/session';
import { loopRecordChanged } from '../../services/learningLoop/sessionStore';
import { localDayStart } from '../../services/learningLoop/standing';
import { DAILY_SET_GOAL, isPracticeFirst, todayAction, type LoopProgress, type TodayAction } from '../../services/learningLoop/stats';
import type { LoopMode } from '../../services/learningLoop/cues';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import type { LoopSpeech } from './loopAudio';
import type { TodayFooter } from './todayKeys';

// What Today's screens show, worked out from the loop's state as plain data, so the screens only draw it and the tests
// can pin every state without a browser. The loop's rules live in services/learningLoop; this module only words and
// arranges what they decide.

const DAY_MS = 86_400_000;

/** How Today names a theme: the taxonomy's emoji and title. */
export interface ThemeLabel {
  emoji: string;
  title: string;
}

/** What Today shows: the plan, a session (set or practice), the themes browser, or Card review. */
export type TodayScreen = 'plan' | 'session' | 'themes' | 'classic';

/** Today's mode as DESIGN-v2 names it. */
export type TodayMode = 'plan' | 'set' | 'practice' | 'themes' | 'classic';

export const todayMode = (screen: TodayScreen, session: LoopSession | null): TodayMode =>
  screen === 'session' ? session?.kind ?? 'plan' : screen;

/**
 * Which of Today's own handlers listen: its keys on the plan and in a session, and its Esc in the themes browser and a
 * session. Card review keeps classic Study's keys and Esc, so Today's stay off there, and nothing of Today's listens
 * while something covers the tab (the card view, which has the keys).
 */
export function todayHandlers(screen: TodayScreen, hasSession: boolean, covered: boolean): { keys: boolean; escape: boolean } {
  if (covered) return { keys: false, escape: false };
  const inSession = screen === 'session' && hasSession;
  return { keys: screen === 'plan' || inSession, escape: screen === 'themes' || inSession };
}

/** Items with no theme yet, or one this build doesn't know. */
export const UNSORTED: ThemeLabel = { emoji: '🗂️', title: 'Unsorted' };

export function themeLabel(themeId: string | null): ThemeLabel {
  const theme = themeId === null ? undefined : themeById(themeId);
  return theme ? { emoji: theme.emoji, title: theme.title } : UNSORTED;
}

/** The plan's date line: 'Wednesday, November 18'. */
export const formatPlanDate = (now: number): string =>
  new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * Which session to take up as Today opens: the newer of its own record and classic Study's (the other is offered with
 * Resume), or neither. A tie goes to Today's.
 */
export function pickRestore(loopSavedAt: number | null, classicSavedAt: number | null): 'loop' | 'classic' | null {
  if (loopSavedAt === null) return classicSavedAt === null ? null : 'classic';
  return classicSavedAt !== null && classicSavedAt > loopSavedAt ? 'classic' : 'loop';
}

/** Where the theme map stands, for a plan with no set: still loading, unreachable with nothing kept, or in hand. */
export type ThemesStatus = 'loading' | 'offline' | 'ready';

/** The plan card's practice row: what's due, done, or nothing in practice yet. */
export type PracticeRow = { kind: 'due'; due: number } | { kind: 'done' } | { kind: 'empty' };

/** The plan card's set row. */
export type SetRow =
  /** The day's goal is met: '✓ 12 today'. */
  | { kind: 'met'; count: number }
  /** The load governor: 'Practice first · 46 due'. */
  | { kind: 'practice-first'; due: number }
  | { kind: 'set'; theme: ThemeLabel; size: number }
  /** No set yet, while the server sorts the library into themes. */
  | { kind: 'sorting'; percent: number }
  | { kind: 'loading' }
  /** No theme map on this device, and the server out of reach: 'Themes load when you're online.' */
  | { kind: 'offline' }
  /** Every theme's new items are met. */
  | { kind: 'empty' };

export interface PlanCardModel {
  practice: PracticeRow;
  set: SetRow;
  /** The one primary button (services/learningLoop/stats.ts todayAction). */
  action: TodayAction;
  /** Done for today, with a set left: the secondary 'Another set: <theme>'. */
  another: { set: PlannedSet; theme: ThemeLabel } | null;
}

export interface PlanCardInput {
  progress: Pick<LoopProgress, 'practiceDue' | 'practicing'>;
  /** Today's count toward the goal (todaySetCount); before the history loads, only this device's unsent reviews. */
  todayCount: number;
  historyLoaded: boolean;
  /** The plan's next set (LoopPlan.today). */
  next: PlannedSet | null;
  themes: ThemesStatus;
  /** How far the server's sorting has got (sortingPercent), while it still has items to sort; null otherwise. */
  sortingPercent: number | null;
}

/**
 * The plan card. The practice row counts what's due; the set row names the next set, or why there is none; the button
 * offers practice while any is due, then a set, then 'Done for today', which keeps a set on offer as 'Another set'.
 * The goal reads as met only once the history has loaded, as every count drawn from it.
 */
export function planCardModel({ progress, todayCount, historyLoaded, next, themes, sortingPercent }: PlanCardInput): PlanCardModel {
  const due = progress.practiceDue;
  const practice: PracticeRow = due > 0 ? { kind: 'due', due } : progress.practicing > 0 ? { kind: 'done' } : { kind: 'empty' };
  let set: SetRow;
  if (historyLoaded && todayCount >= DAILY_SET_GOAL) set = { kind: 'met', count: todayCount };
  else if (isPracticeFirst(due)) set = { kind: 'practice-first', due };
  else if (next) set = { kind: 'set', theme: themeLabel(next.themeId), size: next.itemIds.length };
  else if (themes !== 'ready') set = { kind: themes };
  else set = sortingPercent !== null ? { kind: 'sorting', percent: sortingPercent } : { kind: 'empty' };
  const action = todayAction(due, todayCount, next !== null);
  return { practice, set, action, another: action.kind === 'done' && next ? { set: next, theme: themeLabel(next.themeId) } : null };
}

/**
 * When a practice item answered now comes back to practice: practice waits for the day after a review, so any
 * interval ending before tomorrow is out reads 'tomorrow', and a longer one 'in 6d', by calendar days.
 */
export function practiceReturn(nextReview: number, now: number): string {
  const back = Math.max(nextReview, localDayStart(now, 1));
  if (back < localDayStart(now, 2)) return 'tomorrow';
  return `in ${Math.round((localDayStart(back) - localDayStart(now)) / DAY_MS)}d`;
}

/** What each of a run card's two buttons leads to, from the item's schedule after each outcome. */
export interface RunCaptions {
  notYet: string;
  gotIt: string;
}

/**
 * The captions under Not yet and Got it on a run's card. On the first try Not yet records nothing and the item comes
 * back later in the session; Got it is Good, or Hard with the hint, and Good may make it one you can say. On the second
 * try Not yet is Again and Got it is Hard. `next` holds each outcome's nextReview.
 */
export function runCaptions(
  stage: 'first' | 'second',
  hinted: boolean,
  next: Record<AttemptOutcome, number>,
  graduatesOnGood: boolean,
  now: number,
): RunCaptions {
  if (stage === 'second') return { notYet: practiceReturn(next.again, now), gotIt: practiceReturn(next.hard, now) };
  return {
    notYet: 'again soon',
    gotIt: hinted ? practiceReturn(next.hard, now) : graduatesOnGood ? 'can say it' : practiceReturn(next.good, now),
  };
}

/** A colour for what a receipt or button stands for: amber Practice, slate Passive, emerald Can say it and Got it, rose
 *  Not yet; a Got it with help is amber, as Hard is in Study. */
export type LoopTone = 'amber' | 'slate' | 'emerald' | 'rose';

export const MEET_CHOICES: readonly { choice: MeetChoice; label: string; tone: LoopTone }[] = [
  { choice: 'practice', label: 'Practice', tone: 'amber' },
  { choice: 'passive', label: 'Passive', tone: 'slate' },
  { choice: 'say', label: 'Can say it', tone: 'emerald' },
];

/** The line above a card's footer about the review Undo (or, in the Meet, Back) would take back. */
export interface LoopReceipt {
  word: string;
  label: string;
  tone: LoopTone;
  detail?: string;
}

export function meetReceipt(word: string, choice: MeetChoice): LoopReceipt {
  const { label, tone } = MEET_CHOICES.find(entry => entry.choice === choice)!;
  return { word, label, tone };
}

/** A run's recorded answer: Got it (Good), Got it with a hint or on the second try (Hard), or Not yet (Again). */
export function runReceipt(word: string, rating: ReviewRating, tries: number, detail: string): LoopReceipt {
  if (rating === 'hard') return { word, label: tries >= 2 ? 'Got it on the second try' : 'Got it with a hint', tone: 'amber', detail };
  if (rating === 'again') return { word, label: 'Not yet', tone: 'rose', detail };
  return { word, label: 'Got it', tone: 'emerald', detail };
}

/** How an item reads in a receipt or a list: a word card's word, a sentence's text without its markers. */
export function itemText(item: StoredItem): string {
  if (isVocabItem(item)) return item.data.word.trim();
  return isSentenceItem(item) ? stripSentenceMarkers(item.data.text || '').trim() : '';
}

/** Which footer the session's card shows (todayKeys.ts TodayFooter), or null with no card. */
export function cardFooter(session: LoopSession): TodayFooter | null {
  if (currentItemId(session) === undefined) return null;
  if (session.step === 'cue') return 'cue';
  if (session.kind === 'set' && session.phase === 'meet') return session.step === 'encode' ? 'encode' : 'meet';
  const run = runOf(session);
  const id = currentItemId(session);
  return run && id !== undefined && attemptStage(run.attempts[id]) === 'look' ? 'look' : 'run';
}

/** The eyebrow over a run card that comes back: its second try (the hint showing by itself), or the last look. */
export function attemptLabel(session: LoopSession): string | null {
  const run = runOf(session);
  const id = currentItemId(session);
  const stage = run && id !== undefined ? attemptStage(run.attempts[id]) : null;
  return stage === 'second' ? 'Second try' : stage === 'look' ? 'One more look' : null;
}

/** Whether the session has done anything: a Meet choice, or an answer in a run. Ending one that hasn't just closes it. */
export function sessionHasProgress(session: LoopSession): boolean {
  if (session.kind === 'set' && Object.keys(session.meet.choices).length > 0) return true;
  const run = session.kind === 'set' ? session.round : session;
  return Object.values(run.attempts).some(attempt => attempt.tries > 0 || attempt.outcome !== undefined);
}

/**
 * The session in `mode`, when the header's chip switches it. A set's round always records in the current mode, so
 * only a practice session, which keeps its own, changes.
 */
export const withLoopMode = <S extends LoopSession>(session: S, mode: LoopMode): S =>
  session.kind === 'practice' && session.mode !== mode ? { ...session, mode } : session;

/** Whether the session's record must be written again: anything sessionStore's loopRecordChanged sees, or a practice
 *  session's mode, which the chip can switch. */
export function recordNeedsWrite(previous: LoopSession | null, next: LoopSession): boolean {
  return loopRecordChanged(previous, next) || (previous?.kind === 'practice' && next.kind === 'practice' && previous.mode !== next.mode);
}

/** What the answer says aloud: a word in the system voice, a sentence's clip in the voice it was last heard in. */
export function answerSpeech(item: StoredItem, card: LoopCard): LoopSpeech {
  if (card.answer.kind === 'word') return { kind: 'word', text: card.answer.word };
  const style = isSentenceItem(item) ? (item.data as SentenceData).preferredSpeechStyle : undefined;
  return { kind: 'sentence', text: card.answer.text, ...(style ? { style } : {}) };
}

/**
 * The sentences the session shows next, up to `limit`, whose clips can be fetched before their answers play: the items
 * still to meet, or the run's next cards. Words read in the system voice, so they need nothing.
 */
export function upcomingSentences(session: LoopSession, getItem: (id: string) => StoredItem | undefined, limit = 2): LoopSpeech[] {
  const run = runOf(session);
  const ahead = run ? run.queue.slice(run.index + 1) : session.itemIds.slice((session.kind === 'set' ? session.meet.index : 0) + 1);
  const speech: LoopSpeech[] = [];
  for (const id of new Set(ahead)) {
    if (speech.length >= limit) break;
    const item = getItem(id);
    if (!item || !isSentenceItem(item)) continue;
    const data = item.data as SentenceData;
    const text = stripSentenceMarkers(data.text || '').trim();
    if (text) speech.push({ kind: 'sentence', text, ...(data.preferredSpeechStyle ? { style: data.preferredSpeechStyle } : {}) });
  }
  return speech;
}

/** A button on a session's summary: practice the items still due, start the plan's next set, or close. */
export type SummaryAction =
  | { kind: 'practice'; count: number }
  | { kind: 'set'; set: PlannedSet; theme: ThemeLabel; label: 'Next set' | 'Start a set' }
  | { kind: 'done' };

/**
 * A summary's buttons, the primary first. A set's offers the plan's next set, first while the day's goal isn't met,
 * and Done. A practice session's offers more practice while some is still due (the 30 most overdue each time), else a
 * set while the goal isn't met, and Done.
 */
export function summaryActions(kind: LoopSession['kind'], due: number, todayCount: number, next: PlannedSet | null): SummaryAction[] {
  const done: SummaryAction = { kind: 'done' };
  const goalOpen = todayCount < DAILY_SET_GOAL;
  if (kind === 'practice' && due > 0) return [{ kind: 'practice', count: Math.min(due, PRACTICE_SESSION_CAP) }, done];
  if (!next) return [done];
  const set: SummaryAction = { kind: 'set', set: next, theme: themeLabel(next.themeId), label: kind === 'set' ? 'Next set' : 'Start a set' };
  return goalOpen ? [set, done] : [done, set];
}

/** A theme in the themes browser: its numbers, and the set a tap starts (null without a new item). */
export interface ThemeRow {
  themeId: string | null;
  theme: ThemeLabel;
  newCount: number;
  practicingCount: number;
  sayableCount: number;
  total: number;
  set: PlannedSet | null;
}

/** The themes browser's domains, each with its themes that hold an item, and Unsorted, when it has any. */
export interface ThemesBrowserModel {
  domains: { id: string; title: string; emoji: string; themes: ThemeRow[] }[];
  unsorted: ThemeRow | null;
}

const themeRow = (plan: ThemePlan, theme: ThemeLabel): ThemeRow => ({
  themeId: plan.themeId,
  theme,
  newCount: plan.newCount,
  practicingCount: plan.practicingCount,
  sayableCount: plan.sayableCount,
  total: plan.total,
  set: plan.nextSet.length > 0 ? { themeId: plan.themeId, itemIds: plan.nextSet } : null,
});

/**
 * The themes browser from the plan, in the taxonomy's order, which never changes, so a theme keeps its place as its
 * numbers move. Themes and domains without an item the loop takes are left out; Unsorted comes last.
 */
export function themesBrowserModel(plan: Pick<LoopPlan, 'themes' | 'unsorted'>): ThemesBrowserModel {
  const domains = THEME_DOMAINS.flatMap(domain => {
    const themes = domain.themes.flatMap(theme => {
      const planned = plan.themes.get(theme.id);
      return planned ? [themeRow(planned, { emoji: theme.emoji, title: theme.title })] : [];
    });
    return themes.length > 0 ? [{ id: domain.id, title: domain.title, emoji: domain.emoji, themes }] : [];
  });
  return { domains, unsorted: plan.unsorted.total > 0 ? themeRow(plan.unsorted, UNSORTED) : null };
}

/** A summary's headline: 'Set complete · 14 met', 'Practice complete · 20 items', or 'Ended early · 6 of 14 met'. */
export function summaryHeadline(session: LoopSession, endedEarly: boolean): string {
  const total = session.itemIds.length;
  if (session.kind === 'set') {
    const met = Object.keys(session.meet.choices).length;
    return endedEarly ? `Ended early · ${met} of ${total} met` : `Set complete · ${met} met`;
  }
  const practiced = session.itemIds.filter(id => session.attempts[id]?.outcome !== undefined).length;
  return endedEarly ? `Ended early · ${practiced} of ${total} practiced` : `Practice complete · ${practiced} ${practiced === 1 ? 'item' : 'items'}`;
}

/** The plan's offer to take up a session kept from before, when classic Study's was newer and opened instead. */
export function resumeLabel(session: LoopSession, position: number, total: number): string {
  if (session.kind === 'practice') return `Resume practice · ${position} of ${total}`;
  const theme = themeLabel(session.themeId);
  return `Resume set: ${theme.emoji} ${theme.title} · ${position} of ${total}`;
}
