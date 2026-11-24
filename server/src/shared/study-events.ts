// Study signals: one record per stretch of time one of the learner's own sentences is on screen in the sentence lesson
// (an exposure), with what was done with it. They are the data a model that ranks sentences by how well each is known
// will learn from: a Got it is the only thing a review records, so the struggles (a replay, a lookup, the analysis, a
// sentence left without a Got it in a unit) are kept here. Recording them changes nothing the learner sees.
// The client builds them (views/detail/useStudySignals.ts), queues them (services/studyEvents.ts) and sends them to
// POST /api/study-events, which keeps the latest copy of each (server/src/db/study-events.ts).

/** How an exposure ended: a move to the next or previous sentence, auto-play's move, the lesson closing, anything else. */
export const STUDY_EXITS = ['next', 'prev', 'auto', 'close', 'other'] as const;
export type StudyExit = typeof STUDY_EXITS[number];

/** The sentence's schedule as the exposure began, before any Got it in it. */
export interface StudySrsSnapshot {
  totalReviews: number;
  stability: number;
  /** FSRS difficulty, absent on a schedule never reviewed under FSRS. */
  difficulty?: number;
  lapses?: number;
  /** When it was last reviewed (0: never). */
  lastReviewDate: number;
  nextReview: number;
}

export interface StudyEvent {
  /** Unique per exposure; a copy sent again (an unfinished one, finished later) replaces the one stored. */
  id: string;
  itemId: string;
  /** The lesson's review session: 'set:<unit id>' in one of Today's units, absent elsewhere. */
  sessionId?: string;
  /** What the lesson returns to ('Today', 'Sentences', …), so where the sentence was studied can be told apart. */
  from?: string;
  startedAt: number;
  /** The last moment counted: the exposure's end, or when an unfinished copy was taken. */
  endedAt: number;
  /** False on a copy taken while the exposure still ran (the page was hidden); the finished copy replaces it. */
  final: boolean;
  /** Time on screen with the page visible. */
  visibleMs: number;
  /** Of visibleMs, time on the analysis page. */
  analysisMs: number;
  analysisOpens: number;
  /** Reads of the sentence started by the learner (speaker, Space, E, a tapped word). */
  plays: number;
  /** Reads auto-play started. */
  autoPlays: number;
  /** Reads heard to their end, either kind. */
  listens: number;
  /** Clear/Casual chosen. */
  styleSwitches: number;
  /** Terms looked up from the sentence or its analysis. */
  lookups: number;
  /** The terms looked up, first ones first, each trimmed. */
  lookupTerms: string[];
  /** Saved word cards opened from the sentence. */
  cardOpens: number;
  /** Got its recorded during the exposure. */
  gotIts: number;
  /** Visible time before the first Got it, absent without one. */
  firstGotItMs?: number;
  /** Learn later as the exposure ended (true: starred). */
  learnLater: boolean;
  /** Learn later as it began. */
  learnLaterAtStart: boolean;
  /** Whether auto-play ran at any moment of it. */
  autoplay: boolean;
  exit: StudyExit;
  /** The sentence's place in the lesson's run (1-based) and the run's length. */
  position: number;
  runLength: number;
  /** Minutes east of UTC on the device as it began, so the hour of day can be read back. */
  tzOffset: number;
  srs: StudySrsSnapshot;
}

/** At most this many events a request. */
export const MAX_STUDY_EVENTS_PER_REQUEST = 200;
export const MAX_LOOKUP_TERMS = 10;
export const MAX_LOOKUP_TERM_LENGTH = 80;
const MAX_ID_LENGTH = 200;
const MAX_FROM_LENGTH = 40;
// Counts and times past these are a broken client, not a learner.
const MAX_COUNT = 10_000;
const MAX_DURATION_MS = 7 * 24 * 3_600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
const isDuration = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DURATION_MS;
const isTime = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseSrs(value: unknown): StudySrsSnapshot | null {
  if (!isRecord(value)) return null;
  const { totalReviews, stability, difficulty, lapses, lastReviewDate, nextReview } = value;
  if (!isCount(totalReviews) || !isFiniteNonNegative(stability) || !isTime(lastReviewDate) || !isTime(nextReview)) return null;
  if (difficulty !== undefined && !isFiniteNonNegative(difficulty)) return null;
  if (lapses !== undefined && !isCount(lapses)) return null;
  return {
    totalReviews, stability, lastReviewDate, nextReview,
    ...(difficulty !== undefined ? { difficulty } : {}),
    ...(lapses !== undefined ? { lapses } : {}),
  };
}

/** A well-formed study event, holding only the fields above, or null. */
export function parseStudyEvent(value: unknown): StudyEvent | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isId(v.id) || !isId(v.itemId)) return null;
  if (v.sessionId !== undefined && !isId(v.sessionId)) return null;
  if (v.from !== undefined && (typeof v.from !== 'string' || v.from.length > MAX_FROM_LENGTH)) return null;
  if (!isTime(v.startedAt) || !isTime(v.endedAt) || v.endedAt < v.startedAt) return null;
  if (typeof v.final !== 'boolean' || typeof v.learnLater !== 'boolean' || typeof v.learnLaterAtStart !== 'boolean' ||
      typeof v.autoplay !== 'boolean') return null;
  if (!isDuration(v.visibleMs) || !isDuration(v.analysisMs) || v.analysisMs > v.visibleMs) return null;
  for (const key of ['analysisOpens', 'plays', 'autoPlays', 'listens', 'styleSwitches', 'lookups', 'cardOpens', 'gotIts'] as const) {
    if (!isCount(v[key])) return null;
  }
  if (v.firstGotItMs !== undefined && !isDuration(v.firstGotItMs)) return null;
  if (!Array.isArray(v.lookupTerms) || v.lookupTerms.length > MAX_LOOKUP_TERMS ||
      !v.lookupTerms.every(term => typeof term === 'string' && term.length <= MAX_LOOKUP_TERM_LENGTH)) return null;
  if (typeof v.exit !== 'string' || !(STUDY_EXITS as readonly string[]).includes(v.exit)) return null;
  if (!Number.isInteger(v.position) || (v.position as number) < 1 || !isCount(v.runLength)) return null;
  if (!Number.isInteger(v.tzOffset) || Math.abs(v.tzOffset as number) > 14 * 60) return null;
  const srs = parseSrs(v.srs);
  if (!srs) return null;
  return {
    id: v.id, itemId: v.itemId,
    ...(v.sessionId !== undefined ? { sessionId: v.sessionId } : {}),
    ...(v.from !== undefined ? { from: v.from as string } : {}),
    startedAt: v.startedAt, endedAt: v.endedAt as number, final: v.final,
    visibleMs: v.visibleMs, analysisMs: v.analysisMs as number, analysisOpens: v.analysisOpens as number,
    plays: v.plays as number, autoPlays: v.autoPlays as number, listens: v.listens as number,
    styleSwitches: v.styleSwitches as number, lookups: v.lookups as number, lookupTerms: v.lookupTerms as string[],
    cardOpens: v.cardOpens as number, gotIts: v.gotIts as number,
    ...(v.firstGotItMs !== undefined ? { firstGotItMs: v.firstGotItMs as number } : {}),
    learnLater: v.learnLater, learnLaterAtStart: v.learnLaterAtStart, autoplay: v.autoplay,
    exit: v.exit as StudyExit, position: v.position as number, runLength: v.runLength as number,
    tzOffset: v.tzOffset as number, srs,
  };
}

/** POST /api/study-events's answer: how many events it kept and how many it refused as malformed. */
export interface StudyEventsResponse {
  accepted: number;
  rejected: number;
}
