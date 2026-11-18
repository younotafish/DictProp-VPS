import { defaultStorage, parseJson, type StorageLike } from '../browserStorage';
import type { LoopMode } from './cues';
import { SET_START_PENALTY_MS, type TodayPin } from './planner';
import type { Attempt, LoopSession, MeetChoiceRecord, PracticeRun } from './session';

// What Today keeps on this device in localStorage, per signed-in user unless said otherwise: the session in progress,
// so a reload or iOS evicting the app takes it up again, and the small state the plan needs (the mode, the day's pinned
// theme, recent set starts). Each value is checked strictly as it is read, and anything damaged, foreign or too old
// reads as absent; nothing here throws when storage is missing or refuses access. Reviews never live here: they are
// already durable in the review outbox, so a lost record loses only the session's place.

/** How long a session waits to be taken up again: one left longer is over. */
export const LOOP_SESSION_MAX_AGE_MS = 12 * 3_600_000;

export const loopSessionKey = (userId: string): string => `today_session_v1:${userId}`;
export const LOOP_MODE_KEY = 'today_mode_v1';
export const todayPinKey = (userId: string): string => `today_pin_v1:${userId}`;
export const setStartsKey = (userId: string): string => `today_set_starts_v1:${userId}`;

/** The most set starts kept: only the last two days' count (planner.ts SET_START_PENALTY_MS). */
const MAX_SET_STARTS = 50;
/** The most items a stored session may hold (a set takes at most 20, a practice session 30). */
const MAX_SESSION_ITEMS = 100;
/** The longest id kept, as the server allows for ids. */
const MAX_ID_LENGTH = 200;

/** The parts of a session its record keeps: not the card on screen, which starts at its cue again. */
type RecordedSession = Omit<LoopSession, 'step' | 'hintShown' | 'promptStartedAt'>;

interface LoopSessionRecord {
  version: 1;
  userId: string;
  savedAt: number;
  session: RecordedSession;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCount = (value: unknown, max = Infinity): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

function recorded(session: LoopSession): RecordedSession {
  const { step: _step, hintShown: _hintShown, promptStartedAt: _promptStartedAt, ...kept } = session;
  return kept;
}

/** The session's record for `userId`, written at `now`. */
export function encodeLoopSession(session: LoopSession, userId: string, now: number): string {
  const record: LoopSessionRecord = { version: 1, userId, savedAt: now, session: recorded(session) };
  return JSON.stringify(record);
}

function isChoice(value: unknown): value is MeetChoiceRecord {
  if (!isRecord(value)) return false;
  const { choice, eventId, at, totalReviews } = value;
  return (choice === 'practice' || choice === 'passive' || choice === 'say') && isId(eventId) && isTime(at) &&
    isCount(totalReviews) && totalReviews > 0;
}

function isAttempt(value: unknown): value is Attempt {
  if (!isRecord(value)) return false;
  const { tries, hinted, outcome, eventId, at, totalReviews } = value;
  if (!isCount(tries, 3) || typeof hinted !== 'boolean' || !isId(eventId)) return false;
  if (outcome === undefined) return tries <= 1 && at === undefined && totalReviews === undefined;
  // Good is the first try's; Hard the first try's with the hint or the second's; Again the second's, then the look.
  const triesFit = outcome === 'good' ? tries === 1 : outcome === 'hard' ? tries === 1 || tries === 2 : outcome === 'again' && tries >= 2;
  return triesFit && isTime(at) && isCount(totalReviews) && totalReviews > 0;
}

/** A run whose queue holds only the session's items, each with its attempt, and whose place is within it. */
function isRun(value: unknown, itemIds: ReadonlySet<string>): value is PracticeRun {
  if (!isRecord(value)) return false;
  const { queue, index, attempts } = value;
  if (!Array.isArray(queue) || queue.length > 3 * MAX_SESSION_ITEMS || !isRecord(attempts) || !isCount(index, queue.length)) return false;
  const attemptIds = Object.keys(attempts);
  return attemptIds.every(id => itemIds.has(id) && isAttempt(attempts[id])) &&
    queue.every(id => typeof id === 'string' && Object.hasOwn(attempts, id));
}

/** The session a record holds, when it is well formed; its card shows the cue again. */
function decodeSession(value: unknown, now: number): LoopSession | null {
  if (!isRecord(value)) return null;
  const { kind, id, itemIds, startedAt } = value;
  if (!isId(id) || !isTime(startedAt) || !Array.isArray(itemIds) || itemIds.length > MAX_SESSION_ITEMS || !itemIds.every(isId)) return null;
  const ids = new Set(itemIds);
  if (ids.size !== itemIds.length) return null;
  const card = { step: 'cue' as const, promptStartedAt: now };

  if (kind === 'practice') {
    const { mode } = value;
    if ((mode !== 'speak' && mode !== 'quiet') || !isRun(value, ids)) return null;
    const run: PracticeRun = { queue: value.queue, index: value.index, attempts: value.attempts };
    return {
      kind, id, mode, itemIds, startedAt, ...run, ...card, hintShown: !!run.attempts[run.queue[run.index]]?.hinted,
    };
  }
  if (kind !== 'set') return null;
  const { themeId, phase, meet, round } = value;
  if ((themeId !== null && !isId(themeId)) || (phase !== 'meet' && phase !== 'round' && phase !== 'summary')) return null;
  if (!isRecord(meet) || !isCount(meet.index, itemIds.length) || !isRecord(meet.choices) || !isRun(round, ids)) return null;
  const choices = meet.choices;
  if (!Object.keys(choices).every(choiceId => ids.has(choiceId) && isChoice(choices[choiceId]))) return null;
  // The round is made when the Meet ends, from the items chosen for practice.
  const roundIds = Object.keys(round.attempts);
  const roundFits = phase === 'meet'
    ? roundIds.length === 0
    : roundIds.every(roundId => (choices[roundId] as MeetChoiceRecord | undefined)?.choice === 'practice');
  if (!roundFits) return null;
  return {
    kind,
    id,
    themeId,
    itemIds,
    startedAt,
    phase,
    meet: { index: meet.index, choices: choices as Record<string, MeetChoiceRecord> },
    round,
    ...card,
    hintShown: phase === 'round' && !!round.attempts[round.queue[round.index]]?.hinted,
  };
}

/**
 * The session `raw` holds, and when it was written, when `userId` can take it up at `now`: well formed, theirs, written
 * within the last 12 hours and not in the future. Null for anything else. The screen compares `savedAt` with classic
 * Study's record's: the newer is taken up, and the other offers Resume.
 */
export function decodeLoopSession(raw: string | null, userId: string, now: number): { session: LoopSession; savedAt: number } | null {
  const value = parseJson(raw);
  if (!isRecord(value) || value.version !== 1 || value.userId !== userId) return null;
  const { savedAt } = value;
  if (!isTime(savedAt) || savedAt > now || now - savedAt > LOOP_SESSION_MAX_AGE_MS) return null;
  const session = decodeSession(value.session, now);
  return session ? { session, savedAt } : null;
}

export function readLoopSession(
  userId: string,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): { session: LoopSession; savedAt: number } | null {
  try {
    return decodeLoopSession(storage?.getItem(loopSessionKey(userId)) ?? null, userId, now);
  } catch {
    return null;
  }
}

export function writeLoopSession(session: LoopSession, userId: string, now: number, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(loopSessionKey(userId), encodeLoopSession(session, userId, now));
  } catch {
    // Storage full or refused: the session just won't survive a reload.
  }
}

/** Done, or a record that can't be taken up: a reload brings nothing back. */
export function clearLoopSession(userId: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(loopSessionKey(userId));
  } catch {
    // Storage unavailable.
  }
}

/**
 * Whether the record of `previous` (the session last written) no longer describes `next`: another session, phase,
 * item, choice or attempt. Revealing a card or moving its clock changes nothing the record holds. Sessions change by
 * replacing the parts that change, so comparing parts by identity is enough.
 */
export function loopRecordChanged(previous: LoopSession | null, next: LoopSession): boolean {
  if (!previous || previous.id !== next.id || previous.kind !== next.kind) return true;
  if (previous.kind === 'set' && next.kind === 'set') {
    return previous.phase !== next.phase || previous.meet !== next.meet || previous.round !== next.round;
  }
  if (previous.kind === 'practice' && next.kind === 'practice') {
    return previous.index !== next.index || previous.queue !== next.queue || previous.attempts !== next.attempts;
  }
  return true;
}

/** This device's mode, Speak unless Quiet was chosen. Shared by everyone on the device, like the speech settings. */
export function readLoopMode(storage: StorageLike | null = defaultStorage()): LoopMode {
  try {
    return storage?.getItem(LOOP_MODE_KEY) === 'quiet' ? 'quiet' : 'speak';
  } catch {
    return 'speak';
  }
}

export function writeLoopMode(mode: LoopMode, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(LOOP_MODE_KEY, mode);
  } catch {
    // Storage full or refused: the mode lasts for this visit.
  }
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's pinned theme as stored (planner.ts keeps it current); null when there's none or it's damaged. */
export function readTodayPin(userId: string, storage: StorageLike | null = defaultStorage()): TodayPin | null {
  try {
    const value = parseJson(storage?.getItem(todayPinKey(userId)) ?? null);
    if (!isRecord(value) || typeof value.day !== 'string' || !DAY_KEY.test(value.day) || !isId(value.themeId)) return null;
    return { day: value.day, themeId: value.themeId };
  } catch {
    return null;
  }
}

/** Keeps the plan's pin, or removes it (null). */
export function writeTodayPin(userId: string, pin: TodayPin | null, storage: StorageLike | null = defaultStorage()): void {
  try {
    if (pin) storage?.setItem(todayPinKey(userId), JSON.stringify({ day: pin.day, themeId: pin.themeId }));
    else storage?.removeItem(todayPinKey(userId));
  } catch {
    // Storage full or refused: the plan picks again on the next visit.
  }
}

/** The starts that still count at `now`: within SET_START_PENALTY_MS, the newest MAX_SET_STARTS. */
function keptStarts(starts: Iterable<[string, number]>, now: number): Record<string, number> {
  const kept = [...starts]
    .filter(([themeId, at]) => isId(themeId) && isTime(at) && now - at < SET_START_PENALTY_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SET_STARTS);
  return Object.fromEntries(kept);
}

/** When a set was last started from each theme on this device, as far as the planner's two-day penalty still counts. */
export function readSetStarts(userId: string, now: number, storage: StorageLike | null = defaultStorage()): Record<string, number> {
  try {
    const value = parseJson(storage?.getItem(setStartsKey(userId)) ?? null);
    return isRecord(value) ? keptStarts(Object.entries(value) as [string, number][], now) : {};
  } catch {
    return {};
  }
}

/** Notes a set started from `themeId` at `now` (a set from Unsorted isn't noted), and returns the starts kept. */
export function recordSetStart(
  userId: string,
  themeId: string | null,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): Record<string, number> {
  const starts = readSetStarts(userId, now, storage);
  if (themeId === null) return starts;
  const kept = keptStarts(new Map([...Object.entries(starts), [themeId, now]]), now);
  try {
    storage?.setItem(setStartsKey(userId), JSON.stringify(kept));
  } catch {
    // Storage full or refused: the penalty holds for this visit only.
  }
  return kept;
}
