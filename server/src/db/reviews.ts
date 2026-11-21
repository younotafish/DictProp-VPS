import { ConflictError } from '../errors.js';
import type { ReviewRating, ReviewTaskType } from '../shared/review.js';
import { advanceReviewSrs } from '../srs.js';
import type { ItemType } from '../validation-helpers.js';
import { db, writeTransaction } from './connection.js';
import { getItemById, stmts, writeItem, type StoredItemRecord, type ItemRow, type ItemWrite } from './items.js';
import { sortedKeys } from './item-write.js';
import { allocateRevision } from './revisions.js';

export interface ReviewEvent {
  id: string;
  itemId: string;
  itemType: ItemType;
  reviewedAt: number;
  previousStep: number;
  nextStep: number;
  rating?: ReviewRating;
  taskType?: ReviewTaskType;
  durationMs?: number;
  sessionId?: string;
}

interface ReviewEventColumns {
  id: string;
  item_id: string;
  item_type: ItemType;
  reviewed_at: number;
  previous_step: number;
  next_step: number;
  rating: ReviewRating | null;
  task_type: ReviewTaskType | null;
  duration_ms: number | null;
  session_id: string | null;
}

interface ReviewEventDbRow extends ReviewEventColumns {
  user_id: string;
  undone_at: number | null;
}

/** A stored review as the API sends it: optional fields a review didn't record are left out. */
function rowToReviewEvent(row: ReviewEventColumns): ReviewEvent {
  return {
    id: row.id, itemId: row.item_id, itemType: row.item_type, reviewedAt: row.reviewed_at,
    previousStep: row.previous_step, nextStep: row.next_step,
    rating: row.rating || 'good',
    ...(row.task_type ? { taskType: row.task_type } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  };
}

// The reviews Today's streak counts: a sentence Got it'd in one of Today's units, a 'quick' review in the unit's 'set:'
// session. A 'triage' there is a choice made in a set before units replaced sets, so the days those met still count.
// Only sentences count, as on the client (stats.ts): a word triaged while Today still took words isn't one the goal
// asks for. Any rollback build must keep task_type IN ('quick', 'triage'), or the streak loses every unit day older
// than the client's 8-day history.
const SET_DAY_REVIEWS = `FROM review_events
    WHERE user_id = ? AND reviewed_at >= ? AND task_type IN ('quick', 'triage') AND item_type = 'sentence'
      AND session_id LIKE 'set:%' AND undone_at IS NULL`;

export const reviewStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO review_events
    (id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id)
    VALUES (@id, @user_id, @item_id, @item_type, @reviewed_at, @previous_step, @next_step, @rating, @task_type, @duration_ms, @session_id)`),
  recent: db.prepare(`SELECT id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id
    FROM review_events WHERE user_id = ? AND reviewed_at >= ? AND undone_at IS NULL ORDER BY reviewed_at`),
  timesBetween: db.prepare(`SELECT reviewed_at FROM review_events
    WHERE user_id = ? AND reviewed_at >= ? AND reviewed_at < ? AND undone_at IS NULL ORDER BY reviewed_at`).pluck(),
  countBefore: db.prepare(`SELECT COUNT(*) FROM review_events
    WHERE user_id = ? AND reviewed_at < ? AND undone_at IS NULL`).pluck(),
  // The streak's reviews (SET_DAY_REVIEWS) per day, the day being the review's date shifted by the asked offset, in ms.
  setDays: db.prepare(`SELECT date((reviewed_at + ?) / 1000, 'unixepoch') AS day, COUNT(DISTINCT item_id) AS items
    ${SET_DAY_REVIEWS}
    GROUP BY day`),
  // The same reviews one by one, for days that are calendar days in a time zone, which SQLite can't tell (getSetDays).
  setDayRows: db.prepare(`SELECT reviewed_at, item_id ${SET_DAY_REVIEWS}`),
  byId: db.prepare(`SELECT id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id, undone_at
    FROM review_events WHERE id = ?`),
  insertItemSnapshot: db.prepare(`INSERT INTO review_event_items (event_id, item_id, previous_srs, applied_srs, base_revision, applied_revision)
    VALUES (?, ?, ?, ?, ?, ?)`),
  snapshotsByEvent: db.prepare(`SELECT item_id, previous_srs, applied_srs, base_revision, applied_revision
    FROM review_event_items WHERE event_id = ? ORDER BY item_id`),
  markUndone: db.prepare(`UPDATE review_events SET undone_at = ? WHERE id = ? AND user_id = ? AND undone_at IS NULL`),
};

export function getReviewEvents(userId: string, since: number): ReviewEvent[] {
  return (reviewStmts.recent.all(userId, since) as ReviewEventColumns[]).map(rowToReviewEvent);
}

/** A year and a day: as far back as the study dashboard's streak can reach. */
const REVIEW_TIMES_REACH = 366 * 24 * 60 * 60 * 1000;

export interface ReviewHistoryRows {
  recent: ReviewEvent[];
  olderTimes: number[];
  olderCount: number;
}

/**
 * The review history the study dashboard needs: every review since `recentSince` in full, and for older
 * ones only when they happened (the year before, all a streak can use) and how many there are. The full
 * history runs to tens of thousands of reviews, too much to download on every launch.
 */
export function getReviewHistory(userId: string, recentSince: number): ReviewHistoryRows {
  return {
    recent: getReviewEvents(userId, recentSince),
    olderTimes: reviewStmts.timesBetween.all(userId, recentSince - REVIEW_TIMES_REACH, recentSince) as number[],
    olderCount: reviewStmts.countBefore.get(userId, recentSince) as number,
  };
}

/** As far back as Today's streak reaches: a little over a year of days. */
const SET_DAYS_REACH = 400 * 24 * 60 * 60 * 1000;

/**
 * Every offset from UTC that IANA zones keep in the days a streak reaches, and every time one changes, falls on a
 * quarter hour.
 */
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * The calendar day a time falls on in an IANA time zone, as 'YYYY-MM-DD', put together from the date's parts, since a
 * locale's formatted date orders them its own way. All of one UTC quarter hour is one day there, so each quarter hour
 * is formatted once.
 */
function calendarDayIn(timeZone: string): (time: number) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const daysByQuarterHour = new Map<number, string>();
  return time => {
    const quarterHour = Math.floor(time / QUARTER_HOUR_MS);
    let day = daysByQuarterHour.get(quarterHour);
    if (day === undefined) {
      const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
      day = `${parts.year}-${parts.month}-${parts.day}`;
      daysByQuarterHour.set(quarterHour, day);
    }
    return day;
  };
}

/**
 * For Today's streak: how many distinct sentences were Got it'd in Today's units (or decided in its sets, before units)
 * on each day of the last 400, as 'YYYY-MM-DD'. Undone reviews don't count.
 * - With `timeZone`, an IANA zone Intl knows (routes/reviews.ts parseTimeZone), a day is a calendar day in that zone:
 *   the day the device's own clock showed, as the client counts today, whatever daylight saving did in between.
 * - Without one, as an older client asks, a day is the date under `tzOffsetMinutes`, the device's offset east of UTC
 *   now, so across a daylight-saving change a review made in the hour next to midnight counts on the day beside its
 *   own.
 */
export function getSetDays(userId: string, tzOffsetMinutes: number, now = Date.now(), timeZone?: string): Record<string, number> {
  const since = now - SET_DAYS_REACH;
  if (timeZone === undefined) {
    const rows = reviewStmts.setDays.all(tzOffsetMinutes * 60_000, userId, since) as Array<{ day: string; items: number }>;
    return Object.fromEntries(rows.map(row => [row.day, row.items]));
  }
  const dayOf = calendarDayIn(timeZone);
  const itemsByDay = new Map<string, Set<string>>();
  for (const row of reviewStmts.setDayRows.all(userId, since) as Array<{ reviewed_at: number; item_id: string }>) {
    const day = dayOf(row.reviewed_at);
    const items = itemsByDay.get(day) ?? new Set<string>();
    items.add(row.item_id);
    itemsByDay.set(day, items);
  }
  return Object.fromEntries([...itemsByDay].map(([day, items]) => [day, items.size]));
}

export interface AppliedReviewResult {
  applied: boolean;
  event: ReviewEvent;
  items: StoredItemRecord[];
  /**
   * Each item's revision before the review, for items the review was the last change to. A client whose
   * copy has that revision knows the server changed nothing else, so its unsynced edits still apply.
   */
  baseRevisions: Record<string, number>;
}

/**
 * The records that keep review progress for a line of a read-only catalog, Real Life or the Essays: sentence items
 * whose id is the catalog's prefix followed by the line's id (services/catalogProgressIdentity.ts on the client).
 */
const CATALOG_RECORD_PREFIXES = ['real-life-sentence:', 'essay-sentence:'];

/**
 * Whether a review's seed takes the place of this stored row: a catalog record deleted on some device. The line it kept
 * progress for is still in its catalog, where it shows as never reviewed, so reviewing it brings the record back as the
 * reviewing device seeds it instead of being refused.
 */
const isDeletedCatalogRecord = (row: ItemRow): boolean =>
  row.is_deleted === 1 && row.type === 'sentence' && CATALOG_RECORD_PREFIXES.some(prefix => row.id.startsWith(prefix));

interface ReviewSnapshotRow {
  item_id: string;
  previous_srs: string;
  applied_srs: string;
  base_revision: number | null;
  applied_revision: number | null;
}

const applyReviewTransaction = writeTransaction((
  incoming: ReviewEvent,
  userId: string,
  seedItem: ItemWrite | undefined,
): { applied: boolean; event: ReviewEvent; itemIds: string[]; baseRevisions: Record<string, number> } | null => {
  // A retry is answered before any seed is stored: its first attempt stored the seed, and a record deleted since
  // must stay deleted.
  const previous = reviewStmts.byId.get(incoming.id) as ReviewEventDbRow | undefined;
  if (previous) {
    if (previous.user_id !== userId) throw new ConflictError('Review event id belongs to another user');
    const snapshots = reviewStmts.snapshotsByEvent.all(incoming.id) as ReviewSnapshotRow[];
    const storedIds = snapshots.map(row => row.item_id);
    // A retried review reports a base only while the review is still the item's latest change.
    const baseRevisions: Record<string, number> = {};
    if (previous.undone_at === null) {
      for (const snapshot of snapshots) {
        if (snapshot.base_revision === null || snapshot.applied_revision === null) continue;
        const row = stmts.getByIdScoped.get(snapshot.item_id, userId) as ItemRow | undefined;
        if (row?.revision === snapshot.applied_revision) baseRevisions[snapshot.item_id] = snapshot.base_revision;
      }
    }
    return {
      applied: false,
      event: rowToReviewEvent(previous),
      itemIds: storedIds.length > 0 ? storedIds : [incoming.itemId],
      baseRevisions,
    };
  }

  let seededRevision: number | undefined;
  if (seedItem !== undefined) {
    const stored = stmts.getByIdScoped.get(incoming.itemId, userId) as ItemRow | undefined;
    if (!stored || isDeletedCatalogRecord(stored)) {
      seededRevision = writeItem(seedItem, userId, stored ? { replaceTombstone: true } : {}).revision;
    }
  }

  const target = stmts.getByIdScoped.get(incoming.itemId, userId) as ItemRow | undefined;
  if (!target || target.is_deleted === 1) return null;
  const baseSrs = JSON.parse(target.srs);
  const serverNow = Date.now();
  const reviewedAt = Math.max(
    Number(baseSrs.lastReviewDate) || 0,
    Math.min(incoming.reviewedAt, serverNow + 5 * 60 * 1000),
  );
  const rating = incoming.rating || 'good';
  // Scheduled at the clamped time, while the review's own time decides whether it predates the item's last change of
  // practice membership: a decision made offline before a newer one elsewhere schedules but leaves membership alone.
  const nextSrs = advanceReviewSrs(baseSrs, reviewedAt, rating, incoming.taskType, incoming.reviewedAt);
  const event: ReviewEvent = {
    id: incoming.id,
    itemId: target.id,
    itemType: target.type,
    reviewedAt,
    previousStep: Number(baseSrs.totalReviews) || 0,
    nextStep: Number(nextSrs.totalReviews) || 0,
    rating,
    taskType: incoming.taskType,
    durationMs: incoming.durationMs,
    sessionId: incoming.sessionId,
  };
  const inserted = reviewStmts.insert.run({
    id: event.id,
    user_id: userId,
    item_id: event.itemId,
    item_type: event.itemType,
    reviewed_at: event.reviewedAt,
    previous_step: event.previousStep,
    next_step: event.nextStep,
    rating: event.rating,
    task_type: event.taskType || null,
    duration_ms: event.durationMs ?? null,
    session_id: event.sessionId || null,
  });
  if (inserted.changes !== 1) throw new Error('Review event could not be stored');

  const revision = allocateRevision();
  const appliedSrs = JSON.stringify({ ...nextSrs, id: target.id, type: target.type });
  // A seed is the reviewing client's own copy, so the server held nothing that client hasn't seen: its base
  // is the "no revision yet" the client itself holds.
  const baseRevision = target.revision === seededRevision ? 0 : target.revision;
  reviewStmts.insertItemSnapshot.run(event.id, target.id, target.srs, appliedSrs, baseRevision, revision);
  stmts.updateSrs.run(appliedSrs, serverNow, revision, target.id, userId);
  return { applied: true, event, itemIds: [target.id], baseRevisions: { [target.id]: baseRevision } };
});

const itemsById = (ids: string[], userId: string): StoredItemRecord[] =>
  ids.map(id => getItemById(id, userId, false)).filter((item): item is StoredItemRecord => !!item);

/**
 * Apply a review to `event.itemId`. `_itemIds` is the item list the request carries: clients have only ever sent
 * the reviewed item there, and anything else is ignored. `seedItem` is the reviewing client's copy of the item,
 * stored only for a review the server hasn't applied yet, and then only when the server holds no item with that id,
 * or in place of a deleted catalog record, which the review brings back. It commits in the review's transaction, so a
 * failed review leaves no seed behind.
 */
export function applyReviewEvent(
  event: ReviewEvent,
  _itemIds: string[],
  userId: string,
  seedItem?: ItemWrite,
): AppliedReviewResult | null {
  const result = applyReviewTransaction(event, userId, seedItem);
  if (!result) return null;
  return {
    applied: result.applied,
    event: result.event,
    items: itemsById(result.itemIds, userId),
    baseRevisions: result.baseRevisions,
  };
}

export interface UndoneReviewResult {
  undone: boolean;
  eventId: string;
  items: StoredItemRecord[];
  /** Each item's revision before the undo, as AppliedReviewResult reports it for a review. */
  baseRevisions: Record<string, number>;
}

// A device that pushes the reviewed item back can store the same schedule with its keys in another order.
function sameSrs(stored: string, applied: string): boolean {
  if (stored === applied) return true;
  try {
    return JSON.stringify(sortedKeys(JSON.parse(stored))) === JSON.stringify(sortedKeys(JSON.parse(applied)));
  } catch {
    return false;
  }
}

const undoReviewTransaction = writeTransaction((
  eventId: string,
  userId: string,
): { undone: boolean; itemIds: string[]; baseRevisions: Record<string, number> } | null => {
  const event = reviewStmts.byId.get(eventId) as ReviewEventDbRow | undefined;
  if (!event) return null;
  if (event.user_id !== userId) throw new ConflictError('Review event id belongs to another user');

  const snapshots = reviewStmts.snapshotsByEvent.all(eventId) as ReviewSnapshotRow[];
  if (snapshots.length === 0) throw new ConflictError('Review event cannot be undone');
  const itemIds = snapshots.map(snapshot => snapshot.item_id);
  // A retried undo reports no base: the undo's own revision isn't stored.
  if (event.undone_at !== null) return { undone: false, itemIds, baseRevisions: {} };

  const baseRevisions: Record<string, number> = {};
  for (const snapshot of snapshots) {
    const row = stmts.getByIdScoped.get(snapshot.item_id, userId) as ItemRow | undefined;
    if (!row || row.is_deleted === 1 || !sameSrs(row.srs, snapshot.applied_srs)) {
      throw new ConflictError('Review is no longer the latest change for this item');
    }
    baseRevisions[snapshot.item_id] = row.revision;
  }

  const now = Date.now();
  for (const snapshot of snapshots) {
    stmts.updateSrs.run(snapshot.previous_srs, now, allocateRevision(), snapshot.item_id, userId);
  }
  const marked = reviewStmts.markUndone.run(now, eventId, userId);
  if (marked.changes !== 1) throw new Error('Review undo could not be stored');
  return { undone: true, itemIds, baseRevisions };
});

export function undoReviewEvent(eventId: string, userId: string): UndoneReviewResult | null {
  const result = undoReviewTransaction(eventId, userId);
  if (!result) return null;
  return {
    undone: result.undone,
    eventId,
    items: itemsById(result.itemIds, userId),
    baseRevisions: result.baseRevisions,
  };
}
