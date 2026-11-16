/**
 * The record that lets a study session survive a reload, the update pill's Reload or iOS evicting the app: which
 * cards the session holds, where it is and the grades that stand, never a card's content (localStorage holds only
 * small state). The study screen writes it as the session moves on and reads it when it mounts again
 * (views/StudyEnhanced.tsx); services/studySessionStore.ts keeps it.
 */
import type { ReviewRating } from '../types';
import { RATINGS, type StandingGrade, type StudySession } from './studySession';

/** How long a session waits to be taken up again: one left longer is over. */
export const SESSION_RECORD_MAX_AGE_MS = 6 * 3_600_000;

export interface StudySessionRecord {
  version: 2;
  userId: string;
  sessionId: string;
  itemIds: string[];
  index: number;
  grades: StandingGrade[];
  startedAt: number;
  /** When it was written: a card reviewed after it, on another device say, is passed over when it's taken up. */
  savedAt: number;
}

/** What of a session its record holds. */
type RecordedSession = Pick<StudySession, 'id' | 'itemIds' | 'index' | 'grades' | 'startedAt'>;

/** The session's record for `userId`, written at `now`. */
export function encodeStudySession(session: RecordedSession, userId: string, now: number): string {
  const record: StudySessionRecord = {
    version: 2,
    userId,
    sessionId: session.id,
    itemIds: session.itemIds,
    index: session.index,
    grades: session.grades.map(({ itemId, rating }) => ({ itemId, rating })),
    startedAt: session.startedAt,
    savedAt: now,
  };
  return JSON.stringify(record);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRating = (value: unknown): value is ReviewRating => (RATINGS as readonly unknown[]).includes(value);
const isGrade = (value: unknown): value is StandingGrade =>
  !!value && typeof value === 'object' && isString((value as StandingGrade).itemId) && isRating((value as StandingGrade).rating);

/**
 * The record `raw` holds, when `userId` can take it up at `now`: well formed, theirs, saved within the last six hours
 * and not in the future, and at a card of its list. Null for anything else, which the caller clears.
 */
export function decodeStudySession(raw: string, userId: string, now: number): StudySessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { version, userId: owner, sessionId, itemIds, index, grades, startedAt, savedAt } = value as Record<string, unknown>;
  if (version !== 2 || owner !== userId || !isString(sessionId) || sessionId === '') return null;
  if (!Array.isArray(itemIds) || !itemIds.every(isString) || !Array.isArray(grades) || !grades.every(isGrade)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= itemIds.length) return null;
  if (!isTime(startedAt) || !isTime(savedAt) || savedAt > now || now - savedAt > SESSION_RECORD_MAX_AGE_MS) return null;
  return {
    version: 2,
    userId,
    sessionId,
    itemIds,
    index,
    grades: grades.map(({ itemId, rating }) => ({ itemId, rating })),
    startedAt,
    savedAt,
  };
}

/**
 * Where a session taken up again goes on: the first card from the record's place on that is still a study card
 * (`isPresent`: not deleted or archived) and wasn't reviewed after the record was written (`lastReviewOf`), as on
 * another device. A card graded earlier in the session and brought back to its end was reviewed before then, so it
 * stays. Null when no card is left.
 */
export function restoreQueue(
  record: Pick<StudySessionRecord, 'itemIds' | 'index' | 'savedAt'>,
  isPresent: (id: string) => boolean,
  lastReviewOf: (id: string) => number,
): number | null {
  for (let at = record.index; at < record.itemIds.length; at++) {
    const id = record.itemIds[at];
    if (isPresent(id) && lastReviewOf(id) <= record.savedAt) return at;
  }
  return null;
}

/**
 * The session the record describes, at the card at `index` (restoreQueue), unrevealed and unanswered, with its
 * grades, so it counts as before and its own cards aren't taken for reviewed elsewhere. No undo comes back with it: the
 * last grade may still be in the outbox.
 */
export function restoredSession(
  record: StudySessionRecord,
  index: number,
  now: number,
  siblingCounts: Record<string, number>,
): StudySession {
  return {
    id: record.sessionId,
    itemIds: record.itemIds,
    index,
    revealed: false,
    typedAnswer: '',
    promptStartedAt: now,
    startedAt: record.startedAt,
    grades: record.grades,
    siblingCounts,
  };
}

/**
 * Whether the record of `previous` (the session last written) no longer describes `next`: another session, another
 * card, a card brought back, or a grade given or undone. Typing an answer or showing it changes nothing it holds.
 */
export function recordChanged(previous: RecordedSession | null, next: RecordedSession): boolean {
  return !previous || previous.id !== next.id || previous.index !== next.index ||
    previous.itemIds !== next.itemIds || previous.grades !== next.grades;
}
