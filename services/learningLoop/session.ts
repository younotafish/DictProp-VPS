import type { ReviewRating, ReviewTaskType, StoredItem } from '../../types';
import { loopStanding } from '../../server/src/shared/practice';
import { cappedDuration } from '../studySession';
import type { LoopMode } from './cues';
import { isLoopEligible, isPracticeDue, localDayStart } from './standing';

// Today's two sessions as serializable records and pure steps, as services/studySession.ts is for classic Study: the
// Today screen renders a session, calls updateSRS / undoSRSReview with what these steps return, and applies the result.
//
// - A set session meets each item of a set (cue, reveal, then Practice, Passive or Can say it, each recorded at once
//   as a triage review), then runs a round over the items chosen for practice, in the order met, then sums up.
// - A practice session runs over the practice items due today.
// A run (the round, or a practice session) records exactly one review per item: Got it on the first try unaided is
// Good; with the hint, or on the second try (after a Not yet, which records nothing and brings the item back at least
// three cards later), Hard; Not yet twice is Again, after which the item comes back once more to look at, unrecorded.

export type MeetChoice = 'practice' | 'passive' | 'say';
export type AttemptOutcome = 'good' | 'hard' | 'again';

/** The triage rating each Meet choice records: Practice joins practice, Passive is understood only, Can say it. */
export const MEET_RATINGS: Readonly<Record<MeetChoice, ReviewRating>> = { practice: 'again', passive: 'good', say: 'easy' };
/** The task type a practice attempt is recorded as: said aloud, or thought (Quiet, which never graduates). */
export const MODE_TASK_TYPES: Readonly<Record<LoopMode, ReviewTaskType>> = { speak: 'speak', quiet: 'recall' };
/** The most items a practice session takes; the rest wait for another session. */
export const PRACTICE_SESSION_CAP = 30;
/** How many other cards a missed item waits behind before it comes back (fewer only at the end of the run). */
export const REQUEUE_GAP = 3;

/** A review the session recorded: its event, when it was given, and the item's review count once it is applied. */
export interface OwnReview {
  eventId: string;
  at: number;
  /** Every review adds one, so a higher count on the item means it was reviewed elsewhere since (studySession's
   *  isSessionCardLive reads its grades the same way). */
  totalReviews: number;
}

export interface MeetChoiceRecord extends OwnReview {
  choice: MeetChoice;
}

/** One item's attempt in a run. */
export interface Attempt {
  /** Showings answered: 1 after the first try, 2 after the second, 3 once the look after two misses is done. */
  tries: number;
  /** The hint showed: taken on the first try, or shown by itself on the second. Success with it records Hard. */
  hinted: boolean;
  /** The review recorded for the item, once there is one. */
  outcome?: AttemptOutcome;
  /** The event the outcome is recorded under, made with the attempt and kept in the session's record before anything is
   *  recorded, so a commit made again after a reload is a replay the server ignores, never a second review. */
  eventId: string;
  /** When the outcome was recorded and the item's review count after it (OwnReview). */
  at?: number;
  totalReviews?: number;
}

/** A run of attempts: the queue (an item appears again when it comes back), where it is, and each item's attempt. */
export interface PracticeRun {
  queue: string[];
  index: number;
  attempts: Record<string, Attempt>;
}

/** Where the card on screen is: its cue, its answer, or (meeting an item chosen for practice) saying it twice. */
export type CardStep = 'cue' | 'answer' | 'encode';

interface SessionBase {
  id: string;
  /** The items the session began with, in order. */
  itemIds: string[];
  /** When it began: a run passes over an item reviewed elsewhere after this (its own reviews aside). */
  startedAt: number;
  // The card on screen, which the session's record doesn't keep: a session taken up again starts at the cue.
  step: CardStep;
  hintShown: boolean;
  promptStartedAt: number;
}

export interface SetSession extends SessionBase {
  kind: 'set';
  /** Null for a set from Unsorted. */
  themeId: string | null;
  phase: 'meet' | 'round' | 'summary';
  meet: { index: number; choices: Record<string, MeetChoiceRecord> };
  round: PracticeRun;
}

export interface PracticeSession extends SessionBase, PracticeRun {
  kind: 'practice';
  mode: LoopMode;
}

export type LoopSession = SetSession | PracticeSession;

/** What a step asks the screen to record: updateSRS(itemId, rating, context). */
export interface LoopReview {
  itemId: string;
  rating: ReviewRating;
  context: { taskType: ReviewTaskType; durationMs: number; sessionId: string; eventId: string; reviewedAt: number };
}

/** The session id a session's reviews carry. Today's goal counts the triage reviews of sessions starting 'set:'. */
export const reviewSessionId = (session: Pick<LoopSession, 'kind' | 'id'>): string =>
  `${session.kind === 'set' ? 'set' : 'practice'}:${session.id}`;

/** A new attempt, under its own event. */
const newAttempt = (eventId: string): Attempt => ({ tries: 0, hinted: false, eventId });

const freshAttempts = (itemIds: readonly string[], createId: () => string): Record<string, Attempt> =>
  Object.fromEntries([...new Set(itemIds)].map(id => [id, newAttempt(createId())]));

const atCard = <S extends LoopSession>(session: S, now: number, hintShown = false): S =>
  ({ ...session, step: 'cue', hintShown, promptStartedAt: now });

/** A set session over a planned set (services/learningLoop/planner.ts), at the cue of its first item. */
export function startSetSession(id: string, set: { themeId: string | null; itemIds: readonly string[] }, now: number): SetSession {
  return {
    kind: 'set',
    id,
    themeId: set.themeId,
    itemIds: [...set.itemIds],
    startedAt: now,
    phase: 'meet',
    meet: { index: 0, choices: {} },
    round: { queue: [], index: 0, attempts: {} },
    step: 'cue',
    hintShown: false,
    promptStartedAt: now,
  };
}

/**
 * The practice items due now (standing.ts isPracticeDue), the most overdue first and ties by id: the first `cap` for a
 * session, and how many are due in all, so the screen can offer "+N more" after it.
 */
export function practiceQueue(items: readonly StoredItem[], now: number, cap = PRACTICE_SESSION_CAP): { itemIds: string[]; due: number } {
  const todayStart = localDayStart(now);
  const due = items
    .filter(item => isPracticeDue(item, now, todayStart))
    .sort((a, b) => a.srs.nextReview - b.srs.nextReview || (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0));
  return { itemIds: due.slice(0, cap).map(item => item.data.id), due: due.length };
}

/** A practice session over `itemIds` (practiceQueue) in `mode`, at the cue of its first item, each attempt under its own event. */
export function startPracticeSession(
  id: string,
  itemIds: readonly string[],
  mode: LoopMode,
  now: number,
  createId: () => string,
): PracticeSession {
  return {
    kind: 'practice',
    id,
    mode,
    itemIds: [...itemIds],
    startedAt: now,
    queue: [...itemIds],
    index: 0,
    attempts: freshAttempts(itemIds, createId),
    step: 'cue',
    hintShown: false,
    promptStartedAt: now,
  };
}

/** The run a session is in: a set's round, or the practice session itself. Null while a set is meeting its items. */
export function runOf(session: LoopSession): PracticeRun | null {
  if (session.kind === 'practice') return session;
  return session.phase === 'meet' ? null : session.round;
}

const withRun = <S extends LoopSession>(session: S, run: PracticeRun): S =>
  session.kind === 'set' ? { ...session, round: run } : { ...session, queue: run.queue, index: run.index, attempts: run.attempts };

/** The session at the cue of `run`'s card, its hint already showing when the attempt has one (a second try does). */
const atRunCard = <S extends LoopSession>(session: S, run: PracticeRun, now: number): S =>
  atCard(withRun(session, run), now, !!run.attempts[run.queue[run.index]]?.hinted);

/** Where an attempt is: its first try, its second, the look after two misses, or done. */
export type AttemptStage = 'first' | 'second' | 'look' | 'done';

export function attemptStage(attempt: Attempt | undefined): AttemptStage {
  if (!attempt || attempt.outcome === 'good' || attempt.outcome === 'hard') return 'done';
  if (attempt.outcome === 'again') return attempt.tries >= 3 ? 'done' : 'look';
  return attempt.tries === 0 ? 'first' : 'second';
}

/** The id of the item the session shows: the item being met, or the run's; undefined at the summary or a run's end. */
export function currentItemId(session: LoopSession): string | undefined {
  if (session.kind === 'set' && session.phase === 'meet') return session.itemIds[session.meet.index];
  const run = runOf(session);
  return run ? run.queue[run.index] : undefined;
}

/** Whether nothing is left to show: a set at its summary, or a practice session past its last card. */
export const isSessionOver = (session: LoopSession): boolean =>
  session.kind === 'set' ? session.phase === 'summary' : session.index >= session.queue.length;

/** The header's "i / n": the item being met of the set's, or the card of the run's (n grows as missed items come back). */
export function sessionProgress(session: LoopSession): { position: number; total: number } {
  if (session.kind === 'set' && session.phase === 'meet') {
    return { position: Math.min(session.meet.index + 1, session.itemIds.length), total: session.itemIds.length };
  }
  const run = runOf(session);
  if (!run) return { position: 0, total: 0 };
  return { position: Math.min(run.index + 1, run.queue.length), total: run.queue.length };
}

/** The run's record, whatever the phase: a set's round (empty while it meets its items), or the practice session. */
const runRecord = (session: LoopSession): PracticeRun => (session.kind === 'set' ? session.round : session);

/** The session's latest own review of an item: its run outcome, else (in a set) its Meet choice. */
function ownReview(session: LoopSession, itemId: string): OwnReview | undefined {
  const attempt = runRecord(session).attempts[itemId];
  if (attempt?.outcome && attempt.at !== undefined && attempt.totalReviews !== undefined) {
    return { eventId: attempt.eventId, at: attempt.at, totalReviews: attempt.totalReviews };
  }
  return session.kind === 'set' ? session.meet.choices[itemId] : undefined;
}

/** Whether an item being met can still be: in the loop and never reviewed (not met elsewhere meanwhile). */
export const isMeetItemLive = (item: StoredItem | undefined): item is StoredItem =>
  !!item && isLoopEligible(item) && !(Number(item.srs?.totalReviews) > 0);

/**
 * Whether a run still shows an item: in the loop, practicing, and not reviewed elsewhere since the session began or
 * since the session last reviewed it. As in isSessionCardLive, the session's own reviews go by review count: a higher
 * count means a review came after; a lower one is the session's own review not on the device yet (so the item counts
 * as it will be), unless the item's clock moved past it, which a reset does.
 */
export function isRunItemLive(session: LoopSession, item: StoredItem | undefined): item is StoredItem {
  if (!item || !isLoopEligible(item)) return false;
  const own = ownReview(session, item.data.id);
  const count = Number(item.srs?.totalReviews) || 0;
  const lastReview = item.srs?.lastReviewDate ?? 0;
  if (!own) return lastReview <= session.startedAt && loopStanding(item.srs) === 'practicing';
  if (count > own.totalReviews) return false;
  if (count < own.totalReviews) return lastReview <= own.at;
  return loopStanding(item.srs) === 'practicing';
}

const roundAnswered = (run: PracticeRun): boolean =>
  Object.values(run.attempts).some(attempt => attempt.tries > 0 || attempt.outcome !== undefined);

/**
 * The session moved on to what it shows next: past items it can no longer show (deleted, archived, reviewed elsewhere,
 * or no longer new or practicing), from the Meet into the round once every item is met (or to the summary when none
 * was chosen for practice), and to the summary once the round is done. The same session when nothing changes, so
 * the screen can apply it after every change of the library or the session. Moving to a card shows its cue, with the
 * hint already showing on a second try.
 */
export function settleSession<S extends LoopSession>(
  session: S,
  getItem: (id: string) => StoredItem | undefined,
  createId: () => string,
  now: number,
): S {
  let current: LoopSession = session;
  if (current.kind === 'set' && current.phase === 'meet') {
    const { itemIds, meet } = current;
    let index = meet.index;
    // The card saying an item twice stays until Next; any other item already chosen, or no longer new, is passed.
    if (!(current.step === 'encode' && meet.choices[itemIds[index]])) {
      while (index < itemIds.length && (meet.choices[itemIds[index]] || !isMeetItemLive(getItem(itemIds[index])))) index++;
    }
    if (index < itemIds.length) {
      return (index === meet.index ? session : atCard({ ...current, meet: { ...meet, index } }, now)) as S;
    }
    const queue = itemIds.filter(id => meet.choices[id]?.choice === 'practice');
    current = atCard({
      ...current,
      meet: { ...meet, index: itemIds.length },
      phase: queue.length > 0 ? 'round' : 'summary',
      round: { queue, index: 0, attempts: freshAttempts(queue, createId) },
    }, now);
  }
  const run = runOf(current);
  if (!run) return current as S;
  let index = run.index;
  while (index < run.queue.length) {
    const id = run.queue[index];
    if (attemptStage(run.attempts[id]) !== 'done' && isRunItemLive(current, getItem(id))) break;
    index++;
  }
  if (index === run.index) {
    // A round answered to its end is over even when nothing was passed over to get there.
    const over = current.kind === 'set' && current.phase === 'round' && index >= run.queue.length;
    return (over ? { ...current, phase: 'summary' } : current) as S;
  }
  const moved = atRunCard(current, { ...run, index }, now);
  return (moved.kind === 'set' && index >= run.queue.length ? { ...moved, phase: 'summary' } : moved) as S;
}

/** The answer shown, with its audio (the screen plays it inside the tap). */
export const revealAnswer = <S extends LoopSession>(session: S): S =>
  session.step === 'cue' ? { ...session, step: 'answer' } : session;

/**
 * The card's one hint shown, on its cue (once the answer shows, a hint has nothing left to help with). In a run it caps
 * the attempt at Hard, so it is kept with the attempt.
 */
export function takeHint<S extends LoopSession>(session: S): S {
  if (session.hintShown || session.step !== 'cue') return session;
  const run = runOf(session);
  const id = currentItemId(session);
  const attempt = id === undefined ? undefined : run?.attempts[id];
  if (!run || !attempt || id === undefined) return { ...session, hintShown: true };
  return { ...withRun(session, { ...run, attempts: { ...run.attempts, [id]: { ...attempt, hinted: true } } }), hintShown: true };
}

/**
 * The choice made for the item being met, once its answer shows: the triage review to record now, and `advance`, which
 * keeps the choice (with the count its review leaves) and moves on, or, after Practice, keeps the card on its answer to
 * say it twice before Next (finishEncoding). Null when the item can't be chosen now: not the one being met, its answer
 * not shown, or no longer new (met elsewhere, deleted or archived), which settleSession then passes.
 */
export function chooseInMeet(
  session: SetSession,
  item: StoredItem,
  choice: MeetChoice,
  eventId: string,
  now: number,
): { review: LoopReview; advance: (current: SetSession) => SetSession } | null {
  const itemId = item.data.id;
  if (session.phase !== 'meet' || currentItemId(session) !== itemId || session.step !== 'answer' || !isMeetItemLive(item)) {
    return null;
  }
  const record: MeetChoiceRecord = { choice, eventId, at: now, totalReviews: (Number(item.srs?.totalReviews) || 0) + 1 };
  const review: LoopReview = {
    itemId,
    rating: MEET_RATINGS[choice],
    context: {
      taskType: 'triage', durationMs: cappedDuration(session.promptStartedAt, now), sessionId: reviewSessionId(session), eventId,
      reviewedAt: now,
    },
  };
  return {
    review,
    // Applied to the session as it is when the step is taken, as React applies a state update.
    advance: current => {
      if (current.id !== session.id || current.phase !== 'meet' || current.itemIds[current.meet.index] !== itemId) return current;
      const meet = { ...current.meet, choices: { ...current.meet.choices, [itemId]: record } };
      return choice === 'practice'
        ? { ...current, meet, step: 'encode' }
        : atCard({ ...current, meet: { ...meet, index: current.meet.index + 1 } }, now);
    },
  };
}

/** Next, after saying an item chosen for practice twice: on to the next item to meet. */
export function finishEncoding(session: SetSession, now: number): SetSession {
  if (session.phase !== 'meet' || session.step !== 'encode') return session;
  return atCard({ ...session, meet: { ...session.meet, index: session.meet.index + 1 } }, now);
}

/** What Back in the Meet takes back: the latest choice, its event, and where its item is in the set. */
export interface MeetUndo {
  sessionId: string;
  itemId: string;
  eventId: string;
  index: number;
}

/**
 * What Back would take back: the latest choice (the item on screen's while it is said twice, else the nearest item met
 * before it). Back reaches into a round that hasn't answered anything yet, as the Meet's last choice starts it at once,
 * but not into one that has: the round's own undo is for that. Null when nothing was chosen.
 */
export function meetBackTarget(session: SetSession): MeetUndo | null {
  if (session.phase !== 'meet' && roundAnswered(session.round)) return null;
  const from = session.phase !== 'meet'
    ? session.itemIds.length - 1
    : session.step === 'encode' ? session.meet.index : session.meet.index - 1;
  for (let index = Math.min(from, session.itemIds.length - 1); index >= 0; index--) {
    const itemId = session.itemIds[index];
    const choice = session.meet.choices[itemId];
    if (choice) return { sessionId: session.id, itemId, eventId: choice.eventId, index };
  }
  return null;
}

/**
 * The session once the undo of `target` (undoSRSReview of its event) has gone through: back at its item, the answer
 * showing, the choice gone and a round not yet answered set aside (it is made again when the Meet ends). An undo that
 * comes back after the session ended, or once another started, changes nothing. A failed undo changes nothing either:
 * the screen says why (studySession's undoFailureText) and stays.
 */
export function applyMeetBack(current: SetSession | null, target: MeetUndo, now: number): SetSession | null {
  if (!current || current.id !== target.sessionId || current.meet.choices[target.itemId]?.eventId !== target.eventId) return current;
  const { [target.itemId]: _undone, ...choices } = current.meet.choices;
  return {
    ...current,
    phase: 'meet',
    meet: { index: target.index, choices },
    round: { queue: [], index: 0, attempts: {} },
    step: 'answer',
    hintShown: false,
    promptStartedAt: now,
  };
}

/** What undoing a run's recorded review takes: its event, the attempt as it was before, and where its card was. */
export interface AttemptUndo {
  sessionId: string;
  itemId: string;
  eventId: string;
  /** The queue position the answer was given at. */
  index: number;
  previous: Attempt;
  /** The answer brought the item back later in the run. */
  requeued: boolean;
}

/** `queue` with the item at `index` shown again REQUEUE_GAP cards later, or last when fewer are left. */
function requeueLater(queue: readonly string[], index: number): string[] {
  const at = Math.min(index + 1 + REQUEUE_GAP, queue.length);
  return [...queue.slice(0, at), queue[index], ...queue.slice(at)];
}

/**
 * Not yet or Got it on the run's card, once its answer shows. `mode` is the mode a set's round records in (the current
 * one); a practice session keeps its own. Returns the review to record, if this answer records one (a first Not yet
 * doesn't), what undoing it takes, and `advance`, which keeps the attempt and moves on. Null when the card can't be
 * answered now: not the run's card, its answer not shown, already answered for good, or no longer live.
 */
export function answerAttempt(
  session: LoopSession,
  item: StoredItem,
  gotIt: boolean,
  now: number,
  mode: LoopMode,
): { review?: LoopReview; undo?: AttemptUndo; advance: <S extends LoopSession>(current: S) => S } | null {
  const run = runOf(session);
  const itemId = item.data.id;
  if (!run || run.queue[run.index] !== itemId || session.step !== 'answer' || !isRunItemLive(session, item)) return null;
  const previous = run.attempts[itemId];
  const stage = attemptStage(previous);
  if (stage !== 'first' && stage !== 'second') return null;

  let attempt: Attempt;
  if (stage === 'first') {
    attempt = gotIt
      ? { ...previous, tries: 1, outcome: previous.hinted ? 'hard' : 'good' }
      // The second try shows the hint by itself.
      : { ...previous, tries: 1, hinted: true };
  } else {
    attempt = { ...previous, tries: 2, outcome: gotIt ? 'hard' : 'again' };
  }
  const requeued = !gotIt;
  let review: LoopReview | undefined;
  const outcome = attempt.outcome;
  if (outcome) {
    attempt = { ...attempt, at: now, totalReviews: (Number(item.srs?.totalReviews) || 0) + 1 };
    review = {
      itemId,
      rating: outcome,
      context: {
        taskType: MODE_TASK_TYPES[session.kind === 'practice' ? session.mode : mode],
        durationMs: cappedDuration(session.promptStartedAt, now),
        sessionId: reviewSessionId(session),
        eventId: attempt.eventId,
        reviewedAt: now,
      },
    };
  }
  const queue = requeued ? requeueLater(run.queue, run.index) : run.queue;
  const answeredAt = run.index;
  return {
    review,
    undo: review ? { sessionId: session.id, itemId, eventId: attempt.eventId, index: answeredAt, previous, requeued } : undefined,
    advance: <S extends LoopSession>(current: S): S => {
      const currentRun = runOf(current);
      if (current.id !== session.id || !currentRun || currentRun.index !== answeredAt || currentRun.queue[answeredAt] !== itemId) {
        return current;
      }
      return atRunCard(current, { queue, index: answeredAt + 1, attempts: { ...currentRun.attempts, [itemId]: attempt } }, now);
    },
  };
}

/** Next, after the look at an item missed twice: it records nothing, and the run moves on. */
export function finishLook<S extends LoopSession>(session: S, now: number): S {
  const run = runOf(session);
  const id = currentItemId(session);
  if (!run || id === undefined || session.step !== 'answer' || attemptStage(run.attempts[id]) !== 'look') return session;
  return atRunCard(session, { ...run, index: run.index + 1, attempts: { ...run.attempts, [id]: { ...run.attempts[id], tries: 3 } } }, now);
}

/**
 * The session once the undo of a run's review (undoSRSReview of its event) has gone through: back at that card, its
 * answer showing, the attempt as it was before under a new event (`eventId`, as the server keeps the undone one), and
 * the return the answer queued taken back. A set at its summary is in its round again. An undo that comes back after
 * the session ended, or once another started, changes nothing; a failed one changes nothing either.
 */
export function applyUndoneAttempt<S extends LoopSession>(current: S | null, undo: AttemptUndo, eventId: string, now: number): S | null {
  if (!current || current.id !== undo.sessionId) return current;
  const run = runRecord(current);
  if (run.attempts[undo.itemId]?.eventId !== undo.eventId) return current;
  let queue = run.queue;
  if (undo.requeued) {
    const copy = queue.indexOf(undo.itemId, undo.index + 1);
    if (copy >= 0) queue = queue.filter((_, at) => at !== copy);
  }
  const restored = withRun(current, {
    queue,
    index: undo.index,
    attempts: { ...run.attempts, [undo.itemId]: { ...undo.previous, eventId } },
  });
  return {
    ...(restored.kind === 'set' ? { ...restored, phase: 'round' as const } : restored),
    step: 'answer',
    hintShown: undo.previous.hinted,
    promptStartedAt: now,
  } as S;
}

/** What a set's summary says: its Meet choices, and how its round went. */
export interface SetSummary {
  sayable: number;
  passive: number;
  practicing: number;
  /** Round items recorded Good: right on the first try, unaided. */
  firstTry: number;
  /** Round items with a recorded review. */
  rounded: number;
}

export function summarizeSet(session: SetSession): SetSummary {
  const summary: SetSummary = { sayable: 0, passive: 0, practicing: 0, firstTry: 0, rounded: 0 };
  for (const { choice } of Object.values(session.meet.choices)) {
    if (choice === 'say') summary.sayable++;
    else if (choice === 'passive') summary.passive++;
    else summary.practicing++;
  }
  for (const attempt of Object.values(session.round.attempts)) {
    if (!attempt.outcome) continue;
    summary.rounded++;
    if (attempt.outcome === 'good') summary.firstTry++;
  }
  return summary;
}

/** What a practice session's summary says. */
export interface PracticeSummary {
  firstTry: number;
  withHint: number;
  notYet: number;
  /** The share right on the first try, unaided, as a percentage; null with nothing recorded. */
  recallRate: number | null;
  /** The items this session's spoken Good made ones you can say, as their schedules now stand, in session order. */
  graduated: string[];
}

export function summarizePractice(session: PracticeSession, getItem: (id: string) => StoredItem | undefined): PracticeSummary {
  const summary: PracticeSummary = { firstTry: 0, withHint: 0, notYet: 0, recallRate: null, graduated: [] };
  for (const id of session.itemIds) {
    const attempt = session.attempts[id];
    if (attempt?.outcome === 'good') summary.firstTry++;
    else if (attempt?.outcome === 'hard') summary.withHint++;
    else if (attempt?.outcome === 'again') summary.notYet++;
    // Only Good can graduate, and only as spoken; no later review may have made it so instead.
    const item = getItem(id);
    if (attempt?.outcome === 'good' && item && loopStanding(item.srs) === 'sayable' &&
      (Number(item.srs?.totalReviews) || 0) === attempt.totalReviews) summary.graduated.push(id);
  }
  const recorded = summary.firstTry + summary.withHint + summary.notYet;
  summary.recallRate = recorded > 0 ? Math.round((summary.firstTry / recorded) * 100) : null;
  return summary;
}
