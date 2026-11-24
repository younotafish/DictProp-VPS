import type { StudyEvent } from '../shared/study-events.js';
import { db, writeTransaction } from './connection.js';

// Study signals (shared/study-events.ts): the latest copy of each exposure a user's client sent. A copy sent again
// replaces the stored one only when it is the same user's and the stored one isn't final: a finished copy replaces a
// running one whatever its endedAt (a device clock set back between them can't strand it), and a running copy
// replaces another only when it reaches at least as far, so a stale one sent late never takes back a later one.

const stmts = {
  upsert: db.prepare(`INSERT INTO study_events
    (id, user_id, item_id, session_id, started_at, ended_at, visible_ms, got_its, exit, final, data, received_at)
    VALUES (@id, @user_id, @item_id, @session_id, @started_at, @ended_at, @visible_ms, @got_its, @exit, @final, @data,
      @received_at)
    ON CONFLICT (id) DO UPDATE SET item_id = excluded.item_id, session_id = excluded.session_id,
      started_at = excluded.started_at, ended_at = excluded.ended_at, visible_ms = excluded.visible_ms,
      got_its = excluded.got_its, exit = excluded.exit, final = excluded.final, data = excluded.data,
      received_at = excluded.received_at
    WHERE study_events.user_id = excluded.user_id AND study_events.final = 0
      AND (excluded.final = 1 OR excluded.ended_at >= study_events.ended_at)`),
  count: db.prepare(`SELECT COUNT(*) FROM study_events WHERE user_id = ?`).pluck(),
};

/** Stores each event, or the newer copy of one already stored, for `userId`. */
export const recordStudyEvents = writeTransaction((userId: string, events: readonly StudyEvent[], now: number): void => {
  for (const event of events) {
    stmts.upsert.run({
      id: event.id,
      user_id: userId,
      item_id: event.itemId,
      session_id: event.sessionId ?? null,
      started_at: event.startedAt,
      ended_at: event.endedAt,
      visible_ms: event.visibleMs,
      got_its: event.gotIts,
      exit: event.exit,
      final: event.final ? 1 : 0,
      data: JSON.stringify(event),
      received_at: now,
    });
  }
});

/** How many exposures are stored for `userId`. */
export const getStudyEventCount = (userId: string): number => stmts.count.get(userId) as number;
