import {
  MAX_LEARN_LATER_CHANGES_PER_REQUEST, parseLearnLaterChange, type LearnLaterChange, type LearnLaterResponse,
  type LearnLaterSaveResponse,
} from '../server/src/shared/learn-later';
import { defaultStorage, parseJson } from './browserStorage';
import { jsonRequest, requestJson } from './http';

// Learn later on this device (server/src/shared/learn-later.ts): the stars last read from the server, cached in
// localStorage a key per item so the lesson shows them offline, and the changes not sent yet, one localStorage key per item, so two
// tabs never overwrite each other's: each change has a key of its own (item and time), written once and removed only
// when the server has it, so one tab's cleanup can never take another tab's newer change. What a sentence shows is its
// latest unsent change if it has one, else the server's. Only
// the sentence lesson loads this module: it reads the server's stars as it opens and sends what's waiting then, after
// each toggle, and when the connection comes back.

type Storage_ = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export interface LearnLaterState { starred: boolean; changedAt: number }

/** The server's last word on one item, a key per item, so tabs merging different answers never overwrite each other. */
const knownKey = (userId: string, itemId: string) => `learn_later_known_${userId}:${itemId}`;
const pendingPrefix = (userId: string) => `learn_later_pending_${userId}:`;
const pendingKey = (userId: string, change: LearnLaterChange) => `${pendingPrefix(userId)}${change.changedAt}:${change.itemId}`;
/** Set once a full read of the server's stars has landed: only then does an unstarred sentence mean not starred. */
const fullReadKey = (userId: string) => `learn_later_full_v1:${userId}`;

const listeners = new Set<() => void>();
/** Bumped on every change, so useSyncExternalStore sees a new snapshot. */
let version = 0;
const notify = () => {
  version++;
  listeners.forEach(listener => { try { listener(); } catch { /* ignore */ } });
};
/** Another tab's star or unstar arrives as a storage event: this tab shows it at once, and toggles from it. */
const onStorage = (event: StorageEvent) => {
  if (event.key === null || event.key.startsWith('learn_later_')) notify();
};
export const subscribeLearnLater = (listener: () => void): (() => void) => {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};
export const learnLaterVersion = (): number => version;

/** The server's last word on `itemId` as this device holds it, or null. */
function readKnown(userId: string, itemId: string, storage: Storage_): LearnLaterState | null {
  const change = parseLearnLaterChange({ itemId, ...(parseJson(storage.getItem(knownKey(userId, itemId))) as object ?? {}) });
  return change ? { starred: change.starred, changedAt: change.changedAt } : null;
}

/**
 * Keeps `state` as the server's word on `itemId` unless a later one is held; read just before the write, so another
 * tab's newer word on the item isn't overwritten. Returns the word held afterwards. Throws when storage refuses it.
 */
function keepKnown(userId: string, itemId: string, state: LearnLaterState, storage: Storage_): LearnLaterState {
  const held = readKnown(userId, itemId, storage);
  if (held && held.changedAt >= state.changedAt) return held;
  storage.setItem(knownKey(userId, itemId), JSON.stringify(state));
  return state;
}

function readPending(userId: string, storage: Storage_): { key: string; raw: string; change: LearnLaterChange }[] {
  const prefix = pendingPrefix(userId);
  const entries: { key: string; raw: string; change: LearnLaterChange }[] = [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) {
    const raw = storage.getItem(key);
    const change = raw === null ? null : parseLearnLaterChange(parseJson(raw));
    if (raw !== null && change && key === pendingKey(userId, change)) entries.push({ key, raw, change });
    else storage.removeItem(key);
  }
  return entries;
}

/** What the item shows on this device: its unsent change, else the server's last word, else not starred. */
export function learnLaterState(userId: string | undefined, itemId: string, storage: Storage_ | null = defaultStorage()): LearnLaterState {
  if (!userId || !storage) return { starred: false, changedAt: 0 };
  try {
    let pending: LearnLaterChange | undefined;
    for (const entry of readPending(userId, storage)) {
      if (entry.change.itemId === itemId && (!pending || entry.change.changedAt > pending.changedAt)) pending = entry.change;
    }
    if (pending) return { starred: pending.starred, changedAt: pending.changedAt };
    return readKnown(userId, itemId, storage) ?? { starred: false, changedAt: 0 };
  } catch {
    return { starred: false, changedAt: 0 };
  }
}

/**
 * Stars the item (or takes its star away) on this device at once and queues the change. Its time moves past the last
 * change this device knows of, so a clock that ran fast when the star was set can't make a later unstar lose.
 */
export function setLearnLater(
  userId: string, itemId: string, starred: boolean, now = Date.now(), storage: Storage_ | null = defaultStorage(),
): LearnLaterChange | null {
  if (!userId || !storage) return null;
  const previous = learnLaterState(userId, itemId, storage);
  const change: LearnLaterChange = { itemId, starred, changedAt: Math.max(Math.round(now), previous.changedAt + 1) };
  try {
    storage.setItem(pendingKey(userId, change), JSON.stringify(change));
  } catch {
    return null;
  }
  notify();
  return change;
}

/**
 * Whether this device has read all the server's stars at least once (a full read, not one PUT's answer), so a sentence
 * shown unstarred is known to be.
 */
export function learnLaterKnown(userId: string | undefined, storage: Storage_ | null = defaultStorage()): boolean {
  try {
    return !!userId && !!storage && storage.getItem(fullReadKey(userId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Folds the server's word on some items into what this device knows (the later change of an item wins), and drops each
 * unsent change the server already has or beat: one made earlier than the server's, wherever that was made. A pending
 * change written after this read began (another tab) is left alone, since it's compared by its stored text.
 */
export function applyServerLearnLater(
  userId: string, items: LearnLaterResponse['items'], storage: Storage_ | null = defaultStorage(),
): boolean {
  if (!userId || !storage) return false;
  let saved = false;
  try {
    const pending = readPending(userId, storage);
    for (const itemId of Object.keys(items)) {
      const change = parseLearnLaterChange({ itemId, ...items[itemId] });
      if (change) keepKnown(userId, itemId, { starred: change.starred, changedAt: change.changedAt }, storage);
    }
    saved = true;
    // A change the server already has or beat leaves the outbox, only now that the cache shows the server's word.
    for (const entry of pending) {
      const knownAt = readKnown(userId, entry.change.itemId, storage)?.changedAt ?? -1;
      if (knownAt >= entry.change.changedAt) storage.removeItem(entry.key);
    }
  } catch {
    // A full or refused storage keeps what it had, its unsent changes included.
  }
  notify();
  return saved;
}

export type SendLearnLater = (changes: LearnLaterChange[]) => Promise<LearnLaterSaveResponse>;
const sendToServer: SendLearnLater = changes =>
  requestJson<LearnLaterSaveResponse>('/api/learn-later', jsonRequest('PUT', { changes }), 'Save Learn later');
export type LoadLearnLater = () => Promise<LearnLaterResponse>;
const loadFromServer: LoadLearnLater = () => requestJson<LearnLaterResponse>('/api/learn-later', undefined, 'Load Learn later');

const flushing = new Set<string>();
const flushAgain = new Set<string>();

/**
 * Sends this device's unsent changes, removing each the server took unless a newer one was made meanwhile, and keeps
 * them as known. Stops at a failure: they wait for the next lesson, toggle or reconnect. One at a time per user; a call
 * while one is out runs once more after it.
 */
export async function flushLearnLater(
  userId: string, { storage = defaultStorage(), send = sendToServer }: { storage?: Storage_ | null; send?: SendLearnLater } = {},
): Promise<void> {
  if (!userId || !storage) return;
  if (flushing.has(userId)) { flushAgain.add(userId); return; }
  flushing.add(userId);
  flushAgain.delete(userId);
  try {
    for (let round = 0; round < 10; round++) {
      const batch = readPending(userId, storage).slice(0, MAX_LEARN_LATER_CHANGES_PER_REQUEST);
      if (batch.length === 0) break;
      let answer: LearnLaterSaveResponse;
      try {
        answer = await send(batch.map(entry => entry.change));
      } catch {
        break;
      }
      // The server's word on each item it was sent, the winner included when a later change beat ours; then each sent
      // change leaves the outbox unless a newer one was written to its key meanwhile.
      const items: LearnLaterResponse['items'] = Object.create(null);
      for (const { change } of batch) items[change.itemId] = { starred: change.starred, changedAt: change.changedAt };
      const answered = answer && typeof answer === 'object' && answer.items ? answer.items : {};
      for (const itemId of Object.keys(answered)) items[itemId] = answered[itemId];
      // A sent change leaves the outbox only once the cache holds the server's word on it, so a full storage never
      // shows an older state than the server's; each key holds one change, written once, so this takes no other.
      if (!applyServerLearnLater(userId, items, storage)) break;
      for (const { key } of batch) storage.removeItem(key);
    }
  } catch {
    // Storage that fails mid-flush leaves the rest for next time.
  } finally {
    flushing.delete(userId);
  }
  if (flushAgain.delete(userId)) await flushLearnLater(userId, { storage, send });
}

/** Reads the server's stars, then sends what's waiting here: as the lesson opens, and as the connection comes back. */
export async function syncLearnLater(
  userId: string,
  { storage = defaultStorage(), load = loadFromServer, send = sendToServer }:
    { storage?: Storage_ | null; load?: LoadLearnLater; send?: SendLearnLater } = {},
): Promise<void> {
  if (!userId || !storage) return;
  try {
    if (applyServerLearnLater(userId, (await load()).items, storage)) storage.setItem(fullReadKey(userId), '1');
  } catch {
    // Offline: the cached stars and the unsent changes still show.
  }
  await flushLearnLater(userId, { storage, send });
}
