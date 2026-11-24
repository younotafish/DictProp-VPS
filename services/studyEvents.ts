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
/**
 * A batch's body stays under these, so no request meets the server's 512 kB limit or, sent with keepalive as the page
 * hides, the 64 kB browsers allow keepalive bodies.
 */
const MAX_BATCH_BYTES = 400 * 1024;
const MAX_KEEPALIVE_BYTES = 56 * 1024;
/** Events a page that's hiding sends at most, in one request. */
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

/** Sends batches until the queue is empty or a send fails (what's left goes next time). */
async function drainQueue(userId: string, storage: QueueStorage, send: SendStudyEvents): Promise<void> {
  // Bounded, so a server that keeps taking a batch without its events leaving the queue can't loop forever.
  for (let round = 0; round < 10; round++) {
    const batch = takeBatch(readQueue(userId, storage), MAX_STUDY_EVENTS_PER_REQUEST, MAX_BATCH_BYTES);
    if (batch.length === 0) return;
    try {
      await send(batch.map(entry => entry.event), false);
    } catch {
      return;
    }
    for (const entry of batch) {
      if (storage.getItem(entry.key) === entry.raw) storage.removeItem(entry.key);
    }
  }
}

const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const flushing = new Set<string>();
/** A flush asked for while one was out: run again when it ends, so a reconnect during a failing request isn't lost. */
const flushAgain = new Set<string>();
/** When the last keepalive send went: a hide fires visibilitychange and pagehide back to back, and browsers cap the
 *  keepalive bodies in flight together at 64 kB, so the second one within this window is left to the next foreground. */
let lastKeepaliveAt = -Infinity;
const KEEPALIVE_SPACING_MS = 2_000;
const encoder = new TextEncoder();

/** The leading entries that fit in one request of `maxCount` events and `maxBytes` of body (one, whatever its size). */
function takeBatch<T extends { raw: string }>(entries: T[], maxCount: number, maxBytes: number): T[] {
  const batch: T[] = [];
  let bytes = 16; // {"events":[...]}
  for (const entry of entries) {
    const size = encoder.encode(entry.raw).length + 1;
    if (batch.length >= maxCount || (batch.length > 0 && bytes + size > maxBytes)) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
}

/**
 * Sends what's queued for `userId`, a batch at a time, removing each event the server took unless a newer copy of it
 * was queued meanwhile. Stops at the first failure: what's left goes next time. One flush runs at a time per user in a
 * tab; a call while one is out runs once more after it. `keepalive` is for a page that's hiding: one small request that
 * outlives the page, sent even while another flush is out (that one may never finish), with `current` (the running
 * exposure's copy, sent as it is even if storage refused it) ahead of the rest; `now` is for tests.
 */
export async function flushStudyEvents(
  userId: string,
  { keepalive = false, current, storage = defaultStorage(), send = sendToServer, now = monotonicNow() }:
    { keepalive?: boolean; current?: StudyEvent; storage?: QueueStorage | null; send?: SendStudyEvents; now?: number } = {},
): Promise<void> {
  if (!userId || (!storage && !keepalive)) return;
  if (keepalive) {
    if (now - lastKeepaliveAt < KEEPALIVE_SPACING_MS && now >= lastKeepaliveAt) return;
    // The running copy goes whatever storage does: it may have refused the copy, or refuse to be read at all.
    const currentEntry = current ? [{ key: prefix(userId) + current.id, raw: JSON.stringify(current), event: current }] : [];
    let queued: { key: string; raw: string; event: StudyEvent }[] = [];
    try {
      if (storage) queued = readQueue(userId, storage).filter(entry => entry.event.id !== current?.id);
    } catch {
      // Unreadable storage: the running copy alone.
    }
    const batch = takeBatch([...currentEntry, ...queued], KEEPALIVE_BATCH, MAX_KEEPALIVE_BYTES);
    if (batch.length === 0) return;
    lastKeepaliveAt = now;
    try {
      await send(batch.map(entry => entry.event), true);
      for (const entry of batch) {
        if (storage?.getItem(entry.key) === entry.raw) storage.removeItem(entry.key);
      }
    } catch {
      // The page is going; what's left goes when it comes back.
    }
    return;
  }
  if (!storage) return;
  if (flushing.has(userId)) {
    flushAgain.add(userId);
    return;
  }
  flushing.add(userId);
  flushAgain.delete(userId);
  try {
    await drainQueue(userId, storage, send);
  } catch {
    // Storage that fails mid-flush leaves the rest for next time.
  } finally {
    flushing.delete(userId);
  }
  if (flushAgain.delete(userId)) await flushStudyEvents(userId, { storage, send });
}
