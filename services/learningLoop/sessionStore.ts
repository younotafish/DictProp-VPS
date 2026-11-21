import { defaultStorage, parseJson, type StorageLike } from '../browserStorage';
import { SET_START_PENALTY_MS, type TodayPin } from './planner';

// What Today keeps on this device in localStorage, per signed-in user: the active unit, so Continue takes it up after a
// reload or on another day, and the small state the plan needs (the day's pinned theme, recent unit starts). Each value
// is checked strictly as it is read, and anything damaged, foreign or oversized reads as absent; nothing here throws
// when storage is missing or refuses access. Reviews never live here: they are already durable in the review outbox,
// and how far a unit has got is its sentences' schedules, which the library holds.

export const activeUnitKey = (userId: string): string => `today_unit_v1:${userId}`;
export const todayPinKey = (userId: string): string => `today_pin_v1:${userId}`;
export const setStartsKey = (userId: string): string => `today_set_starts_v1:${userId}`;

/** What v3 kept and nothing reads any more: its loop session, per user, and the device's Speak or Quiet mode. */
const v3SessionKey = (userId: string): string => `today_session_v1:${userId}`;
const V3_MODE_KEY = 'today_mode_v1';

/** The most unit starts kept: only the last two days' count (planner.ts SET_START_PENALTY_MS). */
const MAX_SET_STARTS = 50;
/** The most sentences a stored unit may hold (the planner makes units of at most 23). */
const MAX_UNIT_ITEMS = 100;
/** The longest id kept, as the server allows for ids, and for a review's session id. */
const MAX_ID_LENGTH = 200;

/** The unit last started on this device: Today offers it as Continue while any of its sentences needs review. */
export interface ActiveUnit {
  version: 1;
  userId: string;
  /** New at each start (crypto.randomUUID()). The unit's lesson records its reviews in the session 'set:<id>'. */
  id: string;
  /** Its theme, or null for a unit from Unsorted. */
  themeId: string | null;
  /** Its sentences in lesson order. */
  itemIds: string[];
  startedAt: number;
}

/**
 * The session a unit's lesson records its reviews in, by which the day's goal and the streak count them (stats.ts
 * todaySetCount, and the server's set days).
 */
export const unitSessionId = (unit: Pick<ActiveUnit, 'id'>): string => `set:${unit.id}`;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
/** A unit id whose session id is one the server takes, so the reviews made in the unit aren't refused. */
const isUnitId = (value: unknown): value is string => isId(value) && unitSessionId({ id: value }).length <= MAX_ID_LENGTH;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The unit `raw` holds when it is `userId`'s and well formed: an id short enough for its session id, and one to 100
 * distinct sentence ids. Null otherwise.
 */
export function decodeActiveUnit(raw: string | null, userId: string): ActiveUnit | null {
  const value = parseJson(raw);
  if (!isRecord(value) || value.version !== 1 || value.userId !== userId) return null;
  const { id, themeId, itemIds, startedAt } = value;
  if (!isUnitId(id) || (themeId !== null && !isId(themeId)) || !isTime(startedAt)) return null;
  if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > MAX_UNIT_ITEMS || !itemIds.every(isId)) return null;
  if (new Set(itemIds).size !== itemIds.length) return null;
  return { version: 1, userId, id, themeId, itemIds, startedAt };
}

export function readActiveUnit(userId: string, storage: StorageLike | null = defaultStorage()): ActiveUnit | null {
  try {
    return decodeActiveUnit(storage?.getItem(activeUnitKey(userId)) ?? null, userId);
  } catch {
    return null;
  }
}

/**
 * The active unit once what storage holds (`stored`, readActiveUnit) is taken in: the stored unit when it is another
 * one, started no earlier than `current`, as when another window of the app started it; `current` otherwise. It never
 * takes nothing or an older unit in place of `current`, so a unit whose write storage refused still runs for the visit.
 */
export function newerActiveUnit(current: ActiveUnit | null, stored: ActiveUnit | null): ActiveUnit | null {
  return stored && stored.id !== current?.id && stored.startedAt >= (current?.startedAt ?? -Infinity) ? stored : current;
}

/** Keeps `unit` as its user's active unit, in place of the one before. */
export function writeActiveUnit(unit: ActiveUnit, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(activeUnitKey(unit.userId), JSON.stringify(unit));
  } catch {
    // Storage full or refused: the unit runs, but Continue won't find it after a reload.
  }
}

/**
 * Removes what v3 kept, the loop session and the mode, which nothing reads any more. Best effort: storage that refuses
 * keeps them, harmlessly.
 */
export function forgetV3State(userId: string, storage: StorageLike | null = defaultStorage()): void {
  for (const key of [v3SessionKey(userId), V3_MODE_KEY]) {
    try {
      storage?.removeItem(key);
    } catch {
      // Storage unavailable.
    }
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

/** When a unit was last started from each theme on this device, as far as the planner's two-day penalty still counts. */
export function readSetStarts(userId: string, now: number, storage: StorageLike | null = defaultStorage()): Record<string, number> {
  try {
    const value = parseJson(storage?.getItem(setStartsKey(userId)) ?? null);
    return isRecord(value) ? keptStarts(Object.entries(value) as [string, number][], now) : {};
  } catch {
    return {};
  }
}

/** Notes a unit started from `themeId` at `now` (a unit from Unsorted isn't noted), and returns the starts kept. */
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
