import { ConflictError } from '../errors.js';
import type { ReviewRating, ReviewTaskType } from '../shared/review.js';
import { advanceReviewSrs } from '../srs.js';
import { db, writeTransaction } from './connection.js';
import { getItemById, stmts, writeItem, type ItemRow } from './items.js';
import { nextRevision } from './revisions.js';

export interface ReviewEventRow {
  id: string;
  itemId: string;
  itemType: 'vocab' | 'phrase' | 'sentence';
  reviewedAt: number;
  previousStep: number;
  nextStep: number;
  rating?: ReviewRating;
  taskType?: ReviewTaskType;
  durationMs?: number;
  sessionId?: string;
}

const reviewStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO review_events
    (id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id)
    VALUES (@id, @user_id, @item_id, @item_type, @reviewed_at, @previous_step, @next_step, @rating, @task_type, @duration_ms, @session_id)`),
  recent: db.prepare(`SELECT id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id
    FROM review_events WHERE user_id = ? AND reviewed_at >= ? AND undone_at IS NULL ORDER BY reviewed_at`),
  timesBetween: db.prepare(`SELECT reviewed_at FROM review_events
    WHERE user_id = ? AND reviewed_at >= ? AND reviewed_at < ? AND undone_at IS NULL ORDER BY reviewed_at`).pluck(),
  countBefore: db.prepare(`SELECT COUNT(*) FROM review_events
    WHERE user_id = ? AND reviewed_at < ? AND undone_at IS NULL`).pluck(),
  byId: db.prepare(`SELECT id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id, undone_at
    FROM review_events WHERE id = ?`),
  insertItemSnapshot: db.prepare(`INSERT INTO review_event_items (event_id, item_id, previous_srs, applied_srs, base_revision, applied_revision)
    VALUES (?, ?, ?, ?, ?, ?)`),
  snapshotsByEvent: db.prepare(`SELECT item_id, previous_srs, applied_srs, base_revision, applied_revision
    FROM review_event_items WHERE event_id = ? ORDER BY item_id`),
  markUndone: db.prepare(`UPDATE review_events SET undone_at = ? WHERE id = ? AND user_id = ? AND undone_at IS NULL`),
};

export function getReviewEvents(userId: string, since: number): ReviewEventRow[] {
  return (reviewStmts.recent.all(userId, since) as any[]).map(row => ({
    id: row.id, itemId: row.item_id, itemType: row.item_type, reviewedAt: row.reviewed_at,
    previousStep: row.previous_step, nextStep: row.next_step,
    rating: row.rating || 'good',
    ...(row.task_type ? { taskType: row.task_type } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  }));
}

/** A year and a day: as far back as the study dashboard's streak can reach. */
const REVIEW_TIMES_REACH = 366 * 24 * 60 * 60 * 1000;

export interface ReviewHistoryRows {
  recent: ReviewEventRow[];
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

export interface AppliedReviewResult {
  applied: boolean;
  event: ReviewEventRow;
  items: any[];
  /**
   * Each item's revision before the review, for items the review was the last change to. A client whose
   * copy has that revision knows the server changed nothing else, so its unsynced edits still apply.
   */
  baseRevisions: Record<string, number>;
}

interface ReviewSnapshotRow {
  item_id: string;
  previous_srs: string;
  applied_srs: string;
  base_revision: number | null;
  applied_revision: number | null;
}

const applyReviewTransaction = writeTransaction((
  incoming: ReviewEventRow,
  itemIds: string[],
  userId: string,
  seedItem: unknown,
): { applied: boolean; event: ReviewEventRow; itemIds: string[]; baseRevisions: Record<string, number> } | null => {
  let seededRevision: number | undefined;
  if (seedItem !== undefined && !stmts.getByIdScoped.get(incoming.itemId, userId)) {
    seededRevision = writeItem(seedItem, userId, {}).revision;
  }
  const previous = reviewStmts.byId.get(incoming.id) as any;
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
      event: {
        id: previous.id,
        itemId: previous.item_id,
        itemType: previous.item_type,
        reviewedAt: previous.reviewed_at,
        previousStep: previous.previous_step,
        nextStep: previous.next_step,
        rating: previous.rating || 'good',
        taskType: previous.task_type || undefined,
        durationMs: previous.duration_ms ?? undefined,
        sessionId: previous.session_id || undefined,
      },
      itemIds: storedIds.length > 0 ? storedIds : itemIds,
      baseRevisions,
    };
  }

  const rows = itemIds
    .map(id => stmts.getByIdScoped.get(id, userId) as ItemRow | undefined)
    .filter((row): row is ItemRow => !!row && row.is_deleted !== 1);
  const target = rows.find(row => row.id === incoming.itemId);
  if (!target) return null;

  const canonical = rows.reduce((best, row) => {
    const bestSrs = JSON.parse(best.srs);
    const rowSrs = JSON.parse(row.srs);
    const bestReview = Number(bestSrs.lastReviewDate) || 0;
    const rowReview = Number(rowSrs.lastReviewDate) || 0;
    if (rowReview !== bestReview) return rowReview > bestReview ? row : best;
    return (Number(rowSrs.totalReviews) || 0) > (Number(bestSrs.totalReviews) || 0) ? row : best;
  }, target);
  const baseSrs = JSON.parse(canonical.srs);
  const serverNow = Date.now();
  const reviewedAt = Math.max(
    Number(baseSrs.lastReviewDate) || 0,
    Math.min(incoming.reviewedAt, serverNow + 5 * 60 * 1000),
  );
  const rating = incoming.rating || 'good';
  const nextSrs = advanceReviewSrs(baseSrs, reviewedAt, rating);
  const event: ReviewEventRow = {
    id: incoming.id,
    itemId: target.id,
    itemType: target.type as ReviewEventRow['itemType'],
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

  const baseRevisions: Record<string, number> = {};
  for (const row of rows) {
    const revision = (nextRevision.get() as { value: number }).value;
    const siblingSrs = { ...nextSrs, id: row.id, type: row.type };
    const appliedSrs = JSON.stringify(siblingSrs);
    // A seed is the reviewing client's own copy, so the server held nothing that client hasn't seen: its base
    // is the "no revision yet" the client itself holds.
    const baseRevision = row.id === incoming.itemId && row.revision === seededRevision ? 0 : row.revision;
    reviewStmts.insertItemSnapshot.run(event.id, row.id, row.srs, appliedSrs, baseRevision, revision);
    stmts.updateSrs.run(appliedSrs, serverNow, revision, row.id, userId);
    baseRevisions[row.id] = baseRevision;
  }
  return { applied: true, event, itemIds: rows.map(row => row.id), baseRevisions };
});

/**
 * `seedItem` is the reviewing client's copy of the reviewed item, stored only when the server holds no item
 * with that id. It commits in the review's transaction, so a failed review leaves no seed behind.
 */
export function applyReviewEvent(
  event: ReviewEventRow,
  itemIds: string[],
  userId: string,
  seedItem?: unknown,
): AppliedReviewResult | null {
  const uniqueIds = Array.from(new Set([event.itemId, ...itemIds])).slice(0, 100);
  const result = applyReviewTransaction(event, uniqueIds, userId, seedItem);
  if (!result) return null;
  return {
    applied: result.applied,
    event: result.event,
    items: result.itemIds.map(id => getItemById(id, userId, false)).filter(Boolean),
    baseRevisions: result.baseRevisions,
  };
}

export interface UndoneReviewResult {
  undone: boolean;
  eventId: string;
  items: any[];
  /** Each item's revision before the undo, as AppliedReviewResult reports it for a review. */
  baseRevisions: Record<string, number>;
}

function sortedKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
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
  const event = reviewStmts.byId.get(eventId) as any;
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
    const revision = (nextRevision.get() as { value: number }).value;
    stmts.updateSrs.run(snapshot.previous_srs, now, revision, snapshot.item_id, userId);
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
    items: result.itemIds.map(id => getItemById(id, userId, false)).filter(Boolean),
    baseRevisions: result.baseRevisions,
  };
}
