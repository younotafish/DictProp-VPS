import {
  MAX_STUDY_EVENTS_PER_REQUEST, parseStudyEvent, type StudyEvent, type StudyEventsResponse,
} from '../server/src/shared/study-events';
import { defaultStorage, parseJson } from './browserStorage';
import { jsonRequest, requestJson } from './http';

// The study signals waiting to reach the server (server/src/shared/study-events.ts), one localStorage key per exposure,
// so two tabs never overwrite each other's queue and a newer copy of an exposure replaces its older one in place. Only
// the sentence lesson loads this module: it queues as each exposure ends and sends what's queued as it opens, as it
// queues and as the page hides, so what waited while offline goes with the next lesson.

type QueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** Past this many queued exposures (a few hundred kB), new ones are dropped rather than crowding out other storage. */
export const MAX_QUEUED_STUDY_EVENTS = 1500;
/** A request sent as the page hides travels with keepalive, whose body browsers cap at 64 kB: a smaller batch. */
const KEEPALIVE_BATCH = 40;

const prefix = (userId: string) => `study_events_pending_${userId}:`;

function queuedKeys(userId: string, storage: QueueStorage): string[] {
  const start = prefix(userId);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(start)) keys.push(key);
  }
  return keys;
}

/** Queues `event` for `userId`, replacing a copy of the same exposure already queued. Never throws. */
export function queueStudyEvent(userId: string, event: StudyEvent, storage: QueueStorage | null = defaultStorage()): void {
  if (!storage || !userId) return;
  try {
    const key = prefix(userId) + event.id;
    if (storage.getItem(key) === null && queuedKeys(userId, storage).length >= MAX_QUEUED_STUDY_EVENTS) return;
    storage.setItem(key, JSON.stringify(event));
  } catch {
    // A full or refused storage loses this signal, never the lesson.
  }
}

/** Queued events, oldest first, each with its key and the text stored under it; malformed entries are removed. */
function readQueue(userId: string, storage: QueueStorage): { key: string; raw: string; event: StudyEvent }[] {
  const entries: { key: string; raw: string; event: StudyEvent }[] = [];
  for (const key of queuedKeys(userId, storage)) {
    const raw = storage.getItem(key);
    const event = raw === null ? null : parseStudyEvent(parseJson(raw));
    if (raw !== null && event && key === prefix(userId) + event.id) entries.push({ key, raw, event });
    else storage.removeItem(key);
  }
  return entries.sort((a, b) => a.event.startedAt - b.event.startedAt);
}

/** The events queued for `userId`, oldest first. */
export function readQueuedStudyEvents(userId: string, storage: QueueStorage | null = defaultStorage()): StudyEvent[] {
  if (!storage || !userId) return [];
  try {
    return readQueue(userId, storage).map(entry => entry.event);
  } catch {
    return [];
  }
}

export type SendStudyEvents = (events: StudyEvent[], keepalive: boolean) => Promise<unknown>;

const sendToServer: SendStudyEvents = (events, keepalive) => requestJson<StudyEventsResponse>(
  '/api/study-events', { ...jsonRequest('POST', { events }), keepalive }, 'Send study events',
);

const flushing = new Set<string>();

/**
 * Sends what's queued for `userId`, a batch at a time, removing each event the server took unless a newer copy of it
 * was queued meanwhile. Stops at the first failure: what's left goes next time. `keepalive` is for a page that's
 * hiding: one small batch that outlives the page. One flush runs at a time per user in a tab; a second call returns.
 */
export async function flushStudyEvents(
  userId: string,
  { keepalive = false, storage = defaultStorage(), send = sendToServer }:
    { keepalive?: boolean; storage?: QueueStorage | null; send?: SendStudyEvents } = {},
): Promise<void> {
  if (!storage || !userId || flushing.has(userId)) return;
  flushing.add(userId);
  try {
    const batchSize = keepalive ? KEEPALIVE_BATCH : MAX_STUDY_EVENTS_PER_REQUEST;
    // Bounded, so a server that keeps taking a batch without its events leaving the queue can't loop forever.
    for (let round = 0; round < (keepalive ? 1 : 10); round++) {
      const batch = readQueue(userId, storage).slice(0, batchSize);
      if (batch.length === 0) return;
      try {
        await send(batch.map(entry => entry.event), keepalive);
      } catch {
        return;
      }
      for (const entry of batch) {
        if (storage.getItem(entry.key) === entry.raw) storage.removeItem(entry.key);
      }
    }
  } catch {
    // Storage that fails mid-flush leaves the rest for next time.
  } finally {
    flushing.delete(userId);
  }
}
