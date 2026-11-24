import { Hono } from 'hono';
import { getLearnLater, getLearnLaterFor, recordLearnLaterChanges } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonObject } from '../middleware/json-body.js';
import {
  MAX_LEARN_LATER_CHANGES_PER_REQUEST, parseLearnLaterChange, type LearnLaterSaveResponse,
} from '../shared/learn-later.js';

// Learn later (shared/learn-later.ts): GET every item's latest star or unstar; PUT a batch of changes, each applied
// when it was made later than the stored one. A malformed change is counted and dropped, never failing the rest.

export const learnLaterRoutes = new Hono<AppEnv>();

learnLaterRoutes.get('/learn-later', (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json(getLearnLater(c.get('user').id));
});

learnLaterRoutes.put('/learn-later', async (c) => {
  const body = await readJsonObject(c);
  const changes = body?.changes;
  if (!Array.isArray(changes) || changes.length > MAX_LEARN_LATER_CHANGES_PER_REQUEST) {
    return c.json({ error: 'Invalid Learn later changes' }, 400);
  }
  const userId = c.get('user').id;
  const valid = changes.map(parseLearnLaterChange).filter(change => change !== null);
  if (valid.length > 0) recordLearnLaterChanges(userId, valid, Date.now());
  const answer: LearnLaterSaveResponse = {
    accepted: valid.length,
    rejected: changes.length - valid.length,
    items: getLearnLaterFor(userId, valid.map(change => change.itemId)),
  };
  return c.json(answer);
});
