import {
  type ReviewRating,
  type ReviewTaskType,
  type StoredItem,
  getItemSpelling,
  getItemTitle,
  isPhraseItem,
  isVocabItem,
} from '../types';
import { sentenceReviewState } from './sentenceReviewState';
import { createClozePrompt } from './studyPrompt';
// The review-time labels live in services/reviewTime.ts; these names stay reachable here for the modules that import
// them from this file.
export { formatReviewInterval, formatTimeUntil } from './reviewTime';

export interface StudyContent {
  word: string;
  chinese: string;
  definition: string;
  example: string;
}

/**
 * Whether a card is due: studied before, and its next review has come ('due' in services/sentenceReviewState.ts).
 * Never-studied cards wait in the new cards' queue instead, so the dashboard's due count and the review queue
 * both leave them out.
 */
export function isDueForReview(item: StoredItem, now: number): boolean {
  return sentenceReviewState(item.srs, now) === 'due';
}

export function getStudyContent(item: StoredItem): StudyContent {
  if (isVocabItem(item)) {
    return {
      word: item.data.word,
      chinese: item.data.chinese,
      definition: item.data.definition,
      example: item.data.examples?.[0] || '',
    };
  }
  if (isPhraseItem(item)) {
    const vocab = item.data.vocabs?.find(candidate =>
      candidate.word.trim().toLowerCase() === item.data.query.trim().toLowerCase()
    ) || item.data.vocabs?.[0];
    return {
      word: item.data.query,
      chinese: item.data.translation || vocab?.chinese || '',
      definition: vocab?.definition || item.data.grammar || '',
      example: vocab?.examples?.[0] || '',
    };
  }
  return { word: getItemTitle(item), chinese: '', definition: '', example: '' };
}

export function selectReviewTask(item: StoredItem): ReviewTaskType {
  const strength = item.srs?.memoryStrength || 0;
  const reviews = item.srs?.totalReviews || 0;
  if (strength < 30) return 'meaning';
  if (strength < 55) return reviews % 2 === 0 ? 'production' : 'meaning';

  const content = getStudyContent(item);
  const cloze = createClozePrompt(content.example, content.word);
  if (!content.example || !cloze.includes('_____')) return 'production';
  return reviews % 2 === 0 ? 'cloze' : 'listening';
}

export function buildReviewQueue(
  items: readonly StoredItem[],
  now = Date.now(),
  dueLimit = 40,
  newLimit = 10,
): StoredItem[] {
  const due = items
    .filter(item => isDueForReview(item, now))
    .sort((a, b) => (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0));
  const fresh = items
    .filter(item => (item.srs?.totalReviews || 0) === 0)
    .sort((a, b) => a.savedAt - b.savedAt);
  const seenSpellings = new Set<string>();
  const burySiblings = (list: StoredItem[], limit: number) => list.filter(item => {
    const spelling = getItemSpelling(item);
    if (!spelling || seenSpellings.has(spelling)) return false;
    seenSpellings.add(spelling);
    return true;
  }).slice(0, limit);
  return [...burySiblings(due, dueLimit), ...burySiblings(fresh, newLimit)];
}

/** The four grades, in the order of their buttons and of keys 1–4. */
export const RATINGS = ['again', 'hard', 'good', 'easy'] as const satisfies readonly ReviewRating[];

export const emptyRatings = (): Record<ReviewRating, number> => ({ again: 0, hard: 0, good: 0, easy: 0 });

/** A grade that stands in a session: the card it was given to, and which grade. */
export interface StandingGrade {
  itemId: string;
  rating: ReviewRating;
}

/** A review session in progress: the cards it shows, in order, and how far it has got. */
export interface StudySession {
  id: string;
  itemIds: string[];
  index: number;
  revealed: boolean;
  typedAnswer: string;
  promptStartedAt: number;
  /** When the session began: a card reviewed after it, other than by this session, is passed over (isSessionCardLive). */
  startedAt: number;
  /** The session's grades that stand, in the order they were given; undoing one takes it back off the end. */
  grades: StandingGrade[];
  /** Where the cards just passed over begin. One that comes back before the next grade, as an undone
   *  delete or archive brings it, is shown again where it was. */
  passedOverFrom?: number;
}

/** A grade the session recorded, with what undoing it takes. */
export interface SessionGrade {
  eventId: string;
  sessionId: string;
  itemId: string;
  itemIndex: number;
  rating: ReviewRating;
  taskType: ReviewTaskType;
  durationMs: number;
  typedAnswer: string;
  /** Where a grade with a step under a day queued the card's extra showing (requeueShortStep), which undo takes back. */
  requeuedAt?: number;
}

/** A new session over `queue`, at its first card. */
export function startStudySession(id: string, queue: readonly StoredItem[], now: number): StudySession {
  return {
    id,
    itemIds: queue.map(item => item.data.id),
    index: 0,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
    startedAt: now,
    grades: [],
  };
}

/** How many times the session gave each grade, counting the grades that stand. */
export function sessionRatings(session: Pick<StudySession, 'grades'>): Record<ReviewRating, number> {
  const ratings = emptyRatings();
  for (const { rating } of session.grades) ratings[rating]++;
  return ratings;
}

/**
 * The session moved to the card at `index` (see findSessionCard), unrevealed and unanswered. Moving forward
 * marks where the cards passed over begin, unless an earlier run of them is still open.
 */
export function moveSessionTo(session: StudySession, index: number, now: number): StudySession {
  return {
    ...session,
    index,
    passedOverFrom: index > session.index ? session.passedOverFrom ?? session.index : session.passedOverFrom,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
  };
}

/** The most time one prompt records: one left open while the learner was away counts this, not the absence. */
export const PROMPT_TIME_CAP_MS = 120_000;

/** The time from `start` to `now`, at most `cap`, and none for a clock that went back. */
export function cappedDuration(start: number, now: number, cap = PROMPT_TIME_CAP_MS): number {
  return Math.min(cap, Math.max(0, now - start));
}

/**
 * The grade of the card the session shows (`item`, at session.index), and the session's cards with any
 * extra showing that grade queues. `intervalMinutes` is the interval the grade sets (requeueShortStep).
 */
export function gradeSessionCard(
  session: StudySession,
  item: StoredItem,
  rating: ReviewRating,
  eventId: string,
  now: number,
  intervalMinutes: number,
): { grade: SessionGrade; itemIds: string[] } {
  const itemIds = requeueShortStep(session.itemIds, session.index, intervalMinutes);
  return {
    grade: {
      eventId,
      sessionId: session.id,
      itemId: item.data.id,
      itemIndex: session.index,
      rating,
      taskType: selectReviewTask(item),
      durationMs: cappedDuration(session.promptStartedAt, now),
      typedAnswer: session.typedAnswer,
      requeuedAt: itemIds !== session.itemIds ? session.itemIds.length : undefined,
    },
    itemIds,
  };
}

/** The session after `grade`: on to the next card, unrevealed, with the grade standing. */
export function advanceSession(session: StudySession, itemIds: string[], grade: StandingGrade, now: number): StudySession {
  return {
    ...session,
    itemIds,
    index: session.index + 1,
    passedOverFrom: undefined,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
    grades: [...session.grades, { itemId: grade.itemId, rating: grade.rating }],
  };
}

/**
 * The session after `grade` is undone: back at its card, revealed and with the typed answer, the grade no
 * longer standing, and the extra showing it queued taken back if it is still where it was queued.
 */
export function undoSessionGrade(session: StudySession, grade: SessionGrade, now: number): StudySession {
  const last = session.grades[session.grades.length - 1];
  return {
    ...session,
    itemIds: grade.requeuedAt !== undefined && session.itemIds[grade.requeuedAt] === grade.itemId
      ? session.itemIds.filter((_, index) => index !== grade.requeuedAt)
      : session.itemIds,
    index: grade.itemIndex,
    passedOverFrom: undefined,
    revealed: true,
    typedAnswer: grade.typedAnswer,
    promptStartedAt: now,
    grades: last?.itemId === grade.itemId && last.rating === grade.rating ? session.grades.slice(0, -1) : session.grades,
  };
}

/**
 * The session once the undo of `grade` has gone through: undone if it's still the session the grade was made in.
 * An undo that comes back after its session ended, or after another one started, changes nothing.
 */
export function applyUndoneGrade(current: StudySession | null, grade: SessionGrade, now: number): StudySession | null {
  return current?.id === grade.sessionId ? undoSessionGrade(current, grade, now) : current;
}

/**
 * The position of the card a session shows, from `index` on. Cards that left the study list mid-session
 * (deleted or archived) are passed over, and one passed over since `passedOverFrom` that is back, as an
 * undone delete brings it, is shown again where it was. itemIds.length once no card is left.
 */
export function findSessionCard(
  itemIds: readonly string[],
  index: number,
  passedOverFrom: number | undefined,
  has: (id: string) => boolean,
): number {
  for (let at = passedOverFrom ?? index; at < index; at++) if (has(itemIds[at])) return at;
  let at = index;
  while (at < itemIds.length && !has(itemIds[at])) at++;
  return at;
}

/**
 * Whether the session still shows a card: it is in the study list (a deleted or archived card isn't), and it
 * wasn't reviewed elsewhere since the session began, by Got it in the review popup or the card view, or on
 * another device. Every review stamps the card's lastReviewDate, the session's own too, so the cards this
 * session graded don't count as reviewed elsewhere.
 */
export function isSessionCardLive(item: StoredItem | undefined, session: Pick<StudySession, 'startedAt' | 'grades'>): boolean {
  if (!item) return false;
  if ((item.srs?.lastReviewDate ?? 0) <= session.startedAt) return true;
  return session.grades.some(grade => grade.itemId === item.data.id);
}

const DAY_MINUTES = 1_440;

/**
 * A grade whose next review is under a day away (Again's 10 minutes, or Hard's 15 on a new or relearning
 * card) brings the card back at the end of the session, as a further prompt after the rest, rather than
 * leaving it due before the next session starts.
 */
export function requeueShortStep(itemIds: string[], index: number, intervalMinutes: number): string[] {
  return intervalMinutes < DAY_MINUTES && index < itemIds.length ? [...itemIds, itemIds[index]] : itemIds;
}
