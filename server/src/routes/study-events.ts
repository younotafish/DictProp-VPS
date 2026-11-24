import { Hono } from 'hono';
import { recordStudyEvents } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonObject } from '../middleware/json-body.js';
import { MAX_STUDY_EVENTS_PER_REQUEST, parseStudyEvent, type StudyEventsResponse } from '../shared/study-events.js';

// POST /api/study-events: the client's queued study signals (shared/study-events.ts), a batch at a time. A malformed
// event is counted and dropped, never failing the rest, so one bad copy can't hold a device's queue back for good;
// only a body that isn't a batch at all is refused.

export const studyEventsRoutes = new Hono<AppEnv>();

studyEventsRoutes.post('/study-events', async (c) => {
  const body = await readJsonObject(c);
  const events = body?.events;
  if (!Array.isArray(events) || events.length > MAX_STUDY_EVENTS_PER_REQUEST) {
    return c.json({ error: 'Invalid study events' }, 400);
  }
  const valid = events.map(parseStudyEvent).filter(event => event !== null);
  if (valid.length > 0) recordStudyEvents(c.get('user').id, valid, Date.now());
  const answer: StudyEventsResponse = { accepted: valid.length, rejected: events.length - valid.length };
  return c.json(answer);
});
