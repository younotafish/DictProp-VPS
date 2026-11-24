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
  /**
   * Time on screen with the page visible and, from version 2, its window focused: a sentence left open while the
   * learner is in another app or window doesn't count. Still counts a learner who walked away with the screen on;
   * engagedMs doesn't.
   */
  visibleMs: number;
  /**
   * From version 2: of visibleMs, the engaged time. Each gap between two of the learner's actions (a tap, a key, a
   * scroll, a swipe) counts for at most STUDY_IDLE_CAP_MS, and time while the sentence's audio plays counts in full.
   * The time a model should read; absent on version 1 events.
   */
  engagedMs?: number;
  /** How the event was measured: absent (1) before focus and engaged time were counted, 2 since. */
  version?: number;
  /** From version 2: whether the device had read the server's Learn later stars when the exposure began, so
   *  learnLaterAtStart false means not starred rather than not known yet (a fresh installation). */
  learnLaterKnown?: boolean;
  /** From version 2: the kind of device (services/platform.ts deviceKind), so each device's signals can be checked. */
  device?: StudyDevice;
  /** From version 2: whether the app ran installed (opened from the home screen or Dock) rather than in a tab. */
  standalone?: boolean;
  /** Time on the analysis page: of visibleMs (version 1), of engagedMs, under its idle cap (version 2). */
  analysisMs: number;
  analysisOpens: number;
  /** Reads of the sentence started by the learner (speaker, Space, E, a tapped word). */
  plays: number;
  /** Reads auto-play started. */
  autoPlays: number;
  /**
   * Reads heard to their end, either kind; from version 2, only those heard with the lesson attended. The lesson
   * reports a manual read's end once per read and auto-play's once per round of repeats (a round stopped partway
   * reports none), and a round counts as attended or away by where its last repeat ended: a coarse feature.
   */
  listens: number;
  /** From version 2: reads heard to their end while the lesson wasn't attended (auto-play behind another app or a
   *  locked screen). */
  listensAway?: number;
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
  /** Engaged time before the first Got it (version 1: visible time), absent without one. */
  firstGotItMs?: number;
  /** Learn later as the exposure ended (true: starred). */
  learnLater: boolean;
  /** From version 2: how many times the learner starred or unstarred it during the exposure (absent: none). */
  learnLaterToggles?: number;
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

export const STUDY_DEVICES = ['mac', 'iphone', 'ipad', 'android', 'windows', 'other'] as const;
export type StudyDevice = typeof STUDY_DEVICES[number];

/** The current measurement version (StudyEvent.version). */
export const STUDY_EVENT_VERSION = 2;
/** The longest gap between two actions engaged time counts in full: past it the learner is taken to be away. */
export const STUDY_IDLE_CAP_MS = 60_000;

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
  if (v.listensAway !== undefined && !isCount(v.listensAway)) return null;
  if (v.learnLaterToggles !== undefined && !isCount(v.learnLaterToggles)) return null;
  if (v.device !== undefined && (typeof v.device !== 'string' || !(STUDY_DEVICES as readonly string[]).includes(v.device))) return null;
  if (v.standalone !== undefined && typeof v.standalone !== 'boolean') return null;
  if (v.learnLaterKnown !== undefined && typeof v.learnLaterKnown !== 'boolean') return null;
  // A version 2 event measures engaged time, and its first Got it falls within it.
  // (The types are checked above or here before any comparison, so a malformed value is refused, never thrown on.)
  if (typeof v.version === 'number' && v.version >= 2 && (typeof v.engagedMs !== 'number' ||
      (typeof v.firstGotItMs === 'number' && v.firstGotItMs > v.engagedMs))) return null;
  if (v.engagedMs !== undefined && (!isDuration(v.engagedMs) || v.engagedMs > v.visibleMs || v.analysisMs > v.engagedMs)) return null;
  if (v.version !== undefined && (!Number.isInteger(v.version) || (v.version as number) < 1 || (v.version as number) > 1000)) return null;
  if (!Array.isArray(v.lookupTerms) || v.lookupTerms.length > MAX_LOOKUP_TERMS ||
      !v.lookupTerms.every(term => typeof term === 'string' && term.length <= MAX_LOOKUP_TERM_LENGTH)) return null;
  if (typeof v.exit !== 'string' || !(STUDY_EXITS as readonly string[]).includes(v.exit)) return null;
  // A run is the Sentences tab's whole list at most: no interaction cap applies to it.
  if (!Number.isSafeInteger(v.position) || (v.position as number) < 1 || !Number.isSafeInteger(v.runLength) ||
      (v.runLength as number) < 0) return null;
  if (!Number.isInteger(v.tzOffset) || Math.abs(v.tzOffset as number) > 14 * 60) return null;
  const srs = parseSrs(v.srs);
  if (!srs) return null;
  return {
    id: v.id, itemId: v.itemId,
    ...(v.sessionId !== undefined ? { sessionId: v.sessionId } : {}),
    ...(v.from !== undefined ? { from: v.from as string } : {}),
    startedAt: v.startedAt, endedAt: v.endedAt as number, final: v.final,
    visibleMs: v.visibleMs,
    ...(v.engagedMs !== undefined ? { engagedMs: v.engagedMs as number } : {}),
    ...(v.version !== undefined ? { version: v.version as number } : {}),
    ...(v.device !== undefined ? { device: v.device as StudyDevice } : {}),
    ...(v.standalone !== undefined ? { standalone: v.standalone } : {}),
    ...(v.learnLaterKnown !== undefined ? { learnLaterKnown: v.learnLaterKnown } : {}),
    analysisMs: v.analysisMs as number, analysisOpens: v.analysisOpens as number,
    plays: v.plays as number, autoPlays: v.autoPlays as number, listens: v.listens as number,
    ...(v.listensAway !== undefined ? { listensAway: v.listensAway as number } : {}),
    styleSwitches: v.styleSwitches as number, lookups: v.lookups as number, lookupTerms: v.lookupTerms as string[],
    cardOpens: v.cardOpens as number, gotIts: v.gotIts as number,
    ...(v.firstGotItMs !== undefined ? { firstGotItMs: v.firstGotItMs as number } : {}),
    learnLater: v.learnLater,
    ...(v.learnLaterToggles !== undefined ? { learnLaterToggles: v.learnLaterToggles as number } : {}),
    learnLaterAtStart: v.learnLaterAtStart, autoplay: v.autoplay,
    exit: v.exit as StudyExit, position: v.position as number, runLength: v.runLength as number,
    tzOffset: v.tzOffset as number, srs,
  };
}

/** POST /api/study-events's answer: how many events it kept and how many it refused as malformed. */
export interface StudyEventsResponse {
  accepted: number;
  rejected: number;
}
