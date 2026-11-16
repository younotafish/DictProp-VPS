import {
  type ItemGroup,
  type ReviewRating,
  type ReviewTaskType,
  type SRSData,
  type StoredItem,
  getItemSpelling,
  getItemTitle,
  isPhraseItem,
  isVocabItem,
} from '../types';
import { REVIEW_RATINGS } from '../server/src/shared/review';
import { HttpError } from './http';
import { formatReviewInterval } from './reviewTime';
import { sentenceReviewState } from './sentenceReviewState';
import { createClozePrompt, pickExample } from './studyPrompt';

/** What a card's prompts and answer are made from. */
export interface StudyContent {
  word: string;
  /** The sense label ('noun: emotion'); '' for a phrase. */
  sense: string;
  chinese: string;
  definition: string;
  /** The example its cloze and listening prompts use this time (pickExample). */
  example: string;
  /** The word's listed forms and synonyms, which a typed answer is checked against. */
  forms: string[];
  synonyms: string[];
  /** How it's said: the word's IPA, or a phrase's pronunciation; '' when the card has none. */
  ipa?: string;
}

/** The tasks a study session sets; 'quick' is the review popup's. */
export type StudyTaskType = Exclude<ReviewTaskType, 'quick'>;

/**
 * Whether a card is due: studied before, and its next review has come ('due' in services/sentenceReviewState.ts).
 * Never-studied cards wait in the new cards' queue instead, so the dashboard's due count and the review queue
 * both leave them out.
 */
export function isDueForReview(item: StoredItem, now: number): boolean {
  return sentenceReviewState(item.srs, now) === 'due';
}

export function getStudyContent(item: StoredItem): StudyContent {
  const reviews = item.srs?.totalReviews ?? 0;
  if (isVocabItem(item)) {
    return {
      word: item.data.word,
      sense: item.data.sense ?? '',
      chinese: item.data.chinese,
      definition: item.data.definition,
      example: pickExample(item.data.examples, reviews),
      forms: item.data.forms ?? [],
      synonyms: item.data.synonyms ?? [],
      ipa: item.data.ipa ?? '',
    };
  }
  if (isPhraseItem(item)) {
    const exact = item.data.vocabs?.find(candidate =>
      candidate.word.trim().toLowerCase() === item.data.query.trim().toLowerCase()
    );
    const vocab = exact || item.data.vocabs?.[0];
    return {
      word: item.data.query,
      sense: '',
      chinese: item.data.translation || vocab?.chinese || '',
      definition: vocab?.definition || item.data.grammar || '',
      example: pickExample(vocab?.examples, reviews),
      // Only the phrase's own card lists its forms and synonyms; another word of the phrase has its own.
      forms: exact?.forms ?? [],
      synonyms: exact?.synonyms ?? [],
      ipa: item.data.pronunciation ?? '',
    };
  }
  return { word: getItemTitle(item), sense: '', chinese: '', definition: '', example: '', forms: [], synonyms: [], ipa: '' };
}

export function selectReviewTask(item: StoredItem): StudyTaskType {
  const strength = item.srs?.memoryStrength || 0;
  const reviews = item.srs?.totalReviews || 0;
  if (strength < 30) return 'meaning';
  if (strength < 55) return reviews % 2 === 0 ? 'production' : 'meaning';

  const content = getStudyContent(item);
  const cloze = createClozePrompt(content.example, content.word);
  if (!content.example || !cloze.includes('_____')) return 'production';
  return reviews % 2 === 0 ? 'cloze' : 'listening';
}

/** The sentence a card's listening prompt plays, or null when its task this time isn't listening. */
export function listeningPrompt(item: StoredItem): string | null {
  return selectReviewTask(item) === 'listening' ? getStudyContent(item).example : null;
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

/** The four grades, in the order of their buttons and of keys 1–4: the order the review events record them in. */
export const RATINGS = REVIEW_RATINGS;

const emptyRatings = (): Record<ReviewRating, number> => ({ again: 0, hard: 0, good: 0, easy: 0 });

/** A grade that stands in a session: the card it was given to, which grade, when, and the card's review count after it. */
export interface StandingGrade {
  itemId: string;
  rating: ReviewRating;
  /** When it was given, by this device's clock: its review's reviewedAt. */
  at: number;
  /** The card's totalReviews once the grade's review is applied (the review event's nextStep). Every review adds one,
   *  so a card whose count is higher was reviewed again after the grade, whatever any clock says (isSessionCardLive). */
  totalReviews: number;
}

/** A review session in progress: the cards it shows, in order, and how far it has got. */
export interface StudySession {
  id: string;
  itemIds: string[];
  index: number;
  revealed: boolean;
  typedAnswer: string;
  promptStartedAt: number;
  /** When the session began: a card it hasn't graded that was reviewed after then is passed over (isSessionCardLive). */
  startedAt: number;
  /** The session's grades that stand, in the order they were given; undoing one takes it back off the end. */
  grades: StandingGrade[];
  /** For each card whose spelling other study items share, how many share it (sessionSiblingCounts). */
  siblingCounts: Record<string, number>;
  /** Where the cards just passed over begin. One that comes back before the next grade, as an undone
   *  delete or archive brings it, is shown again where it was. */
  passedOverFrom?: number;
  /** The learner ended the session early, after a grade: its summary shows until it's resumed or closed. */
  ended?: boolean;
}

/** A grade the session recorded, with what undoing it takes. */
export interface SessionGrade {
  eventId: string;
  sessionId: string;
  itemId: string;
  itemIndex: number;
  /** The card's word, and the interval the grade set in minutes, for the receipt line (receiptText). */
  word: string;
  intervalMinutes: number;
  rating: ReviewRating;
  taskType: ReviewTaskType;
  durationMs: number;
  typedAnswer: string;
  /** Where a grade with a step under a day queued the card's extra showing (requeueShortStep), which undo takes back. */
  requeuedAt?: number;
}

/** A new session over `queue`, at its first card. */
export function startStudySession(
  id: string,
  queue: readonly StoredItem[],
  now: number,
  siblingCounts: Record<string, number>,
): StudySession {
  return {
    id,
    itemIds: queue.map(item => item.data.id),
    index: 0,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
    startedAt: now,
    grades: [],
    siblingCounts,
  };
}

/**
 * How many study items (`items`) share each queued card's spelling, for the cards that share it with another: a
 * meaning prompt for one of them says it asks for one of that many meanings. A session counts them once, as it
 * starts, so a prompt's line never changes under the learner.
 */
export function sessionSiblingCounts(queue: readonly StoredItem[], items: readonly StoredItem[]): Record<string, number> {
  const perSpelling = new Map<string, number>();
  for (const item of items) {
    const spelling = getItemSpelling(item);
    if (spelling) perSpelling.set(spelling, (perSpelling.get(spelling) ?? 0) + 1);
  }
  const counts: Record<string, number> = {};
  for (const item of queue) {
    const count = perSpelling.get(getItemSpelling(item)) ?? 0;
    if (count >= 2) counts[item.data.id] = count;
  }
  return counts;
}

/** How many times the session gave each grade, counting the grades that stand. */
export function sessionRatings(session: Pick<StudySession, 'grades'>): Record<ReviewRating, number> {
  const ratings = emptyRatings();
  for (const { rating } of session.grades) ratings[rating]++;
  return ratings;
}

/** What the summary at the end of a session says. */
export interface SessionSummary {
  /** The cards the session holds, each once, however often it brought one back. */
  total: number;
  /** The cards with a grade that stands, each once. */
  graded: number;
  /** How many times each grade stands (sessionRatings). */
  counts: Record<ReviewRating, number>;
  /** The cards with a standing Again or Hard, each once, in the order they were first missed. Undoing the grade
   *  takes a card off again, unless another Again or Hard of it still stands. */
  missedIds: string[];
}

export function summarizeSession(session: Pick<StudySession, 'itemIds' | 'grades'>): SessionSummary {
  const missed = new Set<string>();
  for (const { itemId, rating } of session.grades) if (rating === 'again' || rating === 'hard') missed.add(itemId);
  return {
    total: new Set(session.itemIds).size,
    graded: new Set(session.grades.map(grade => grade.itemId)).size,
    counts: sessionRatings(session),
    missedIds: [...missed],
  };
}

/** The session ended early: its summary shows, and Resume takes it up again at the card it was on. */
export function endSessionEarly(session: StudySession): StudySession {
  return { ...session, ended: true };
}

/** A session ended early, taken up again at the card it was on, unrevealed and unanswered. */
export function resumeSession(session: StudySession, now: number): StudySession {
  const { ended: _ended, ...running } = session;
  return moveSessionTo(running, running.index, now);
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
const PROMPT_TIME_CAP_MS = 120_000;

/** The time from `start` to `now`, at most `cap`, and none for a clock that went back. */
export function cappedDuration(start: number, now: number, cap = PROMPT_TIME_CAP_MS): number {
  return Math.min(cap, Math.max(0, now - start));
}

/** What a grade's review is recorded with (StudyEnhanced's onReview). */
export interface SessionReview {
  taskType: ReviewTaskType;
  durationMs: number;
  sessionId: string;
  eventId: string;
  /** The grade's own time, which its standing grade keeps as `at`; the server stamps the card's lastReviewDate from it. */
  reviewedAt: number;
}

/**
 * The grade of the card the session shows (`item`, at session.index), given at `now`: what undoing it takes, the review
 * that records it, and `advance`, which moves the session on with the grade standing (advanceSession). `next` is the
 * card's schedule after the grade, as updateSRS schedules it: its interval may queue an extra showing
 * (requeueShortStep), and the grade keeps its review count, so a review of the card elsewhere afterwards shows
 * (isSessionCardLive). The one `now` stamps both the review and the grade the session keeps.
 */
export function gradeSessionCard(
  session: StudySession,
  item: StoredItem,
  rating: ReviewRating,
  eventId: string,
  now: number,
  next: Pick<SRSData, 'interval' | 'totalReviews'>,
): { grade: SessionGrade; review: SessionReview; advance: (current: StudySession) => StudySession } {
  const itemIds = requeueShortStep(session.itemIds, session.index, next.interval);
  const grade: SessionGrade = {
    eventId,
    sessionId: session.id,
    itemId: item.data.id,
    itemIndex: session.index,
    word: getItemTitle(item),
    intervalMinutes: next.interval,
    rating,
    taskType: selectReviewTask(item),
    durationMs: cappedDuration(session.promptStartedAt, now),
    typedAnswer: session.typedAnswer,
    requeuedAt: itemIds !== session.itemIds ? session.itemIds.length : undefined,
  };
  const standing: StandingGrade = { itemId: grade.itemId, rating, at: now, totalReviews: next.totalReviews };
  return {
    grade,
    review: { taskType: grade.taskType, durationMs: grade.durationMs, sessionId: grade.sessionId, eventId, reviewedAt: standing.at },
    // Applied to the session as it is when the step is taken, as React applies a state update.
    advance: current => advanceSession(current, itemIds, standing, now),
  };
}

/** The session after `grade`, given at `now`: on to the next card of `itemIds`, unrevealed, with the grade standing. */
export function advanceSession(session: StudySession, itemIds: string[], grade: StandingGrade, now: number): StudySession {
  return {
    ...session,
    itemIds,
    index: session.index + 1,
    passedOverFrom: undefined,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
    grades: [...session.grades, grade],
  };
}

/**
 * The session after `grade` is undone: back at its card, revealed and with the typed answer, the grade no
 * longer standing, and the extra showing it queued taken back if it is still where it was queued. A session
 * ended early is running again, as an undo from the summary of a finished one goes back to the card too.
 */
export function undoSessionGrade(session: StudySession, grade: SessionGrade, now: number): StudySession {
  const { ended: _ended, ...running } = session;
  const last = running.grades[running.grades.length - 1];
  return {
    ...running,
    itemIds: grade.requeuedAt !== undefined && running.itemIds[grade.requeuedAt] === grade.itemId
      ? running.itemIds.filter((_, index) => index !== grade.requeuedAt)
      : running.itemIds,
    index: grade.itemIndex,
    passedOverFrom: undefined,
    revealed: true,
    typedAnswer: grade.typedAnswer,
    promptStartedAt: now,
    grades: last?.itemId === grade.itemId && last.rating === grade.rating ? running.grades.slice(0, -1) : running.grades,
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
 * Whether the session still shows a card: it is in the study list (a deleted or archived card isn't), and it wasn't
 * reviewed elsewhere (by Got it in the review popup or the card view, or on another device). A card the session graded
 * goes by its review count, which no clock can skew: a count above the one its latest standing grade left
 * (StandingGrade.totalReviews) means a review came after that grade, as a Got it on a card brought back to the end of
 * the session does. A card the session hasn't graded goes by time: a review after the session began passes it over.
 */
export function isSessionCardLive(item: StoredItem | undefined, session: Pick<StudySession, 'startedAt' | 'grades'>): boolean {
  if (!item) return false;
  // The latest grade, not the highest count: a reset elsewhere between two grades leaves the later one the lower count.
  let latest: StandingGrade | undefined;
  for (const grade of session.grades) if (grade.itemId === item.data.id) latest = grade;
  return latest
    ? (item.srs?.totalReviews ?? 0) <= latest.totalReviews
    : (item.srs?.lastReviewDate ?? 0) <= session.startedAt;
}

/**
 * The sentences the next `limit` listening prompts after the card at `index` will play, among the cards still in the
 * session (isSessionCardLive), so their clips can be fetched before they're needed.
 */
export function upcomingListeningPrompts(
  session: Pick<StudySession, 'itemIds' | 'startedAt' | 'grades'>,
  index: number,
  getItem: (id: string) => StoredItem | undefined,
  limit = 3,
): string[] {
  const prompts: string[] = [];
  for (let at = index + 1; at < session.itemIds.length && prompts.length < limit; at++) {
    const item = getItem(session.itemIds[at]);
    const prompt = item && isSessionCardLive(item, session) ? listeningPrompt(item) : null;
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

/**
 * What Open card shows: the card among the study items (`items`) that share its spelling, its other senses, in their
 * order, so the card view's ← and → reach them. A card no other item shares a spelling with is a list of one.
 */
export function openCardGroup(item: StoredItem, items: readonly StoredItem[]): { group: ItemGroup; index: number } {
  const spelling = getItemSpelling(item);
  const senses = spelling ? items.filter(other => getItemSpelling(other) === spelling) : [];
  const index = senses.findIndex(other => other.data.id === item.data.id);
  return index < 0
    ? { group: { title: getItemTitle(item), items: [item] }, index: 0 }
    : { group: { title: getItemTitle(item), items: senses }, index };
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

/** How long after a reveal or a grade a tap on the study card's footer is taken for the second tap of a double tap. */
const FOOTER_TAP_GUARD_MS = 350;

/**
 * Whether a tap on the study card's footer counts: not within `windowMs` of the last reveal or grade (made any
 * way), so a double tap can't run from Show answer into a grade, or from a grade into the next card's reveal.
 * Keys aren't held back. A clock that went back lets the tap through rather than holding every tap.
 */
export function acceptFooterTap(lastActionAt: number | undefined, now: number, windowMs = FOOTER_TAP_GUARD_MS): boolean {
  return lastActionAt === undefined || now - lastActionAt >= windowMs || now < lastActionAt;
}

/** What the receipt line under a study card says about the last grade (components/study/GradeReceipt.tsx). */
export interface GradeReceiptText {
  word: string;
  rating: ReviewRating;
  /** The grade as its button names it: 'Good'. */
  ratingLabel: string;
  /** When the card comes back ('next in 59d', or 'again later this session' for one the grade brought back), or
   *  'Undoing…' while the grade is being undone; ' · saved on this device' while it waits in the review outbox. */
  detail: string;
}

/** The receipt line for the last grade: '↶ crestfallen · Good · next in 59d'. */
export function receiptText(grade: {
  word: string;
  rating: ReviewRating;
  intervalMinutes: number;
  /** The grade brought the card back later in the session (requeueShortStep). */
  requeued: boolean;
  undoing: boolean;
  /** The grade is still in the review outbox, not yet on the server. */
  waiting: boolean;
}): GradeReceiptText {
  const detail = grade.undoing
    ? 'Undoing…'
    : grade.requeued ? 'again later this session' : `next in ${formatReviewInterval(grade.intervalMinutes)}`;
  return {
    word: grade.word,
    rating: grade.rating,
    ratingLabel: grade.rating.charAt(0).toUpperCase() + grade.rating.slice(1),
    detail: grade.waiting && !grade.undoing ? `${detail} · saved on this device` : detail,
  };
}

/** Why an undo failed: its review is still waiting in the outbox, not yet on the server, or the server's undo failed. */
export type UndoFailure = 'waiting' | { error: unknown };

/**
 * What the receipt line and the summary say when an undo fails, in words rather than the error: the server refuses to
 * take back a review that a later change to the card superseded (409); offline, the undo waits for the connection.
 */
export function undoFailureText(failure: UndoFailure, online: boolean): string {
  if (failure !== 'waiting' && failure.error instanceof HttpError && failure.error.status === 409) {
    return 'This card has changed since, so the review can’t be undone.';
  }
  if (!online) return 'Reconnect to undo this review.';
  return failure === 'waiting' ? 'This review is still syncing. Try undo again.' : 'The review could not be undone.';
}
