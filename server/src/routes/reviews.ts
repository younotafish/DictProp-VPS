import { Hono } from 'hono';
import { applyReviewEvent, getReviewHistory, undoReviewEvent } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonObject } from '../middleware/json-body.js';
import { checkStoredItem, isItemId, MAX_ID_LENGTH, parseReviewEvent, type ValidStoredItem } from '../validation.js';

export const reviewRoutes = new Hono<AppEnv>();

reviewRoutes.get('/reviews/history', (c) => {
  const userId = c.get('user').id;
  const recentSince = Number(c.req.query('recentSince'));
  if (!Number.isFinite(recentSince) || recentSince < 0) return c.json({ error: 'Invalid recentSince parameter' }, 400);
  return c.json(getReviewHistory(userId, recentSince));
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
  // Existing items always win; the seed is used only for a genuinely absent id.
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
