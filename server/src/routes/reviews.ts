import { Hono } from 'hono';
import { applyReviewEvent, getReviewHistory, getSetDays, undoReviewEvent } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonObject } from '../middleware/json-body.js';
import type { SetDaysResponse } from '../shared/review.js';
import { checkStoredItem, isItemId, MAX_ID_LENGTH, parseReviewEvent, type ValidStoredItem } from '../validation.js';

export const reviewRoutes = new Hono<AppEnv>();

// Real UTC offsets run from 12 hours west to 14 east.
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/** Minutes east of UTC, or 0 (UTC) for a value that names no real offset. */
function parseTzOffset(value: string | undefined): number {
  const minutes = Number(value);
  return Number.isInteger(minutes) && Math.abs(minutes) <= MAX_TZ_OFFSET_MINUTES ? minutes : 0;
}

reviewRoutes.get('/reviews/history', (c) => {
  const userId = c.get('user').id;
  const recentSince = Number(c.req.query('recentSince'));
  if (!Number.isFinite(recentSince) || recentSince < 0) return c.json({ error: 'Invalid recentSince parameter' }, 400);
  return c.json(getReviewHistory(userId, recentSince));
});

// Today's streak, for the days before today: per local day, how many items were decided in a set. A missing or
// impossible offset reads as UTC instead of failing, since Today can't show its streak without an answer.
reviewRoutes.get('/reviews/set-days', (c) => {
  const userId = c.get('user').id;
  const body: SetDaysResponse = { days: getSetDays(userId, parseTzOffset(c.req.query('tzOffset'))) };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

// Atomically append an idempotent review event and advance the latest server schedule.
reviewRoutes.post('/reviews/apply', async (c) => {
  const userId = c.get('user').id;
  const body = await readJsonObject(c);
  const event = parseReviewEvent(body?.event);
  // Clients list the reviewed item here; the review applies to event.itemId alone.
  const itemIds = body?.itemIds;
  const seedItem = body?.seedItem;
  if (!event || !Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 100 || !itemIds.every(isItemId)) {
    return c.json({ error: 'Invalid review mutation' }, 400);
  }
  let seed: ValidStoredItem | undefined;
  if (seedItem !== undefined) {
    const checked = checkStoredItem(seedItem);
    if ('error' in checked) return c.json({ error: `Invalid review seed: ${checked.error}` }, 400);
    seed = checked.item;
    if (seed.data.id !== event.itemId || seed.type !== event.itemType ||
        seed.srs.id !== event.itemId || seed.srs.totalReviews !== event.previousStep) {
      return c.json({ error: 'Review seed does not match event' }, 400);
    }
  }
  // A review can reach the server before its item: an implicit catalog sentence on its first review, or an
  // item whose first push hasn't landed. The seed is stored in the review's own transaction, so an
  // offline/retried review cannot race the ordinary item sync or an importer, or advance the schedule twice.
  // Existing items win, except a deleted catalog record, which a new review's seed brings back (db/reviews.ts); otherwise the seed is used only for an absent id.
  const result = applyReviewEvent(event, itemIds, userId, seed);
  if (!result) return c.json({ error: 'Review item not found' }, 404);
  return c.json(result, result.applied ? 201 : 200);
});

reviewRoutes.post('/reviews/:id/undo', (c) => {
  const userId = c.get('user').id;
  const eventId = c.req.param('id');
  if (!eventId || eventId.length > MAX_ID_LENGTH) return c.json({ error: 'Invalid review event id' }, 400);
  const result = undoReviewEvent(eventId, userId);
  if (!result) return c.json({ error: 'Review event not found' }, 404);
  return c.json(result);
});
