/**
 * Durable on-device cache for TTS audio clips + word timings (IndexedDB).
 *
 * WHY: TTS clips are content-addressed — the URL key is sha256(voice + "\n" + text) and the server
 * serves them `immutable` (server/src/routes/tts.ts), so a key's audio never changes. Yet the client's
 * only cache was an in-memory Map (services/neuralTts.ts) that dies on every launch, and the service
 * worker deliberately skips /api/*, so nothing durable held the audio. On iOS/iPadOS that meant every
 * launch re-downloaded every clip from the 1-vCPU VPS — a multi-minute wait before sentences could play.
 *
 * This store gives audio the durability images already have (services/storage.ts): a clip fetched once
 * is written through to here, so the NEXT launch loads it from local disk (sub-ms) with no server round
 * trip. Because keys are content hashes, a cached blob is valid forever — there is no invalidation:
 * changed text = a new key = fetched once; the old key simply goes unused and ages out via LRU.
 *
 * Layout — three stores so eviction never loads blobs into memory:
 *   • audio   : key -> Blob (the clip bytes; ~25 KB MP3 from the VPS)
 *   • meta    : key -> { size, at }  (byte size + last-used ms), with a `by_at` index for LRU
 *   • timings : key -> WordTiming[]  (per-word alignment; ~0.4 KB, evicted alongside its audio)
 *
 * Budget: target ~1.5 GB, adaptively capped at ~70% of what navigator.storage.estimate() reports, so a
 * fuller/smaller device automatically uses less and we never push toward a hard failure. At ~25 KB/clip
 * that is ~60k clips — far beyond the current corpus, so in practice almost nothing re-downloads.
 *
 * Everything degrades gracefully: if IndexedDB is unavailable (e.g. iOS Safari private mode) every call
 * no-ops (reads return null, writes are dropped) and callers fall straight through to the network — i.e.
 * exactly the behaviour before this cache existed. Writes never block or break playback.
 */
import type { WordTiming } from './api';
import { log, warn } from './logger';

const DB_NAME = 'DictPropAudioCache';
const DB_VERSION = 1;
const AUDIO = 'audio';
const META = 'meta';
const TIMINGS = 'timings';
const BY_AT = 'by_at';

// Target ceiling before LRU eviction kicks in, and the fraction of the browser-reported quota we allow
// ourselves at most (so audio never crowds out the rest of the origin's storage on a tight device).
const TARGET_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
const QUOTA_FRACTION = 0.7;

interface MetaRecord { size: number; at: number }

let available: boolean | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

const getDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not supported')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
      if (!db.objectStoreNames.contains(TIMINGS)) db.createObjectStore(TIMINGS);
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META);
        meta.createIndex(BY_AT, 'at'); // ascending cursor => oldest-first, for LRU eviction
      }
    };
  });
  // Reset on failure so a later call can retry cleanly (a rejected cached promise would wedge the cache).
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
};

/** True when IndexedDB is usable here. Cached; a false result (e.g. private mode) makes every op a no-op. */
export const audioCacheReady = async (): Promise<boolean> => {
  if (available !== null) return available;
  try {
    await getDB();
    available = true;
  } catch {
    available = false;
    warn('🔊 Audio cache: IndexedDB unavailable — falling back to network-only');
  }
  return available;
};

const now = (): number => Date.now();

// ── Reads ──────────────────────────────────────────────────────────────────────
/** The cached clip Blob for `key`, or null on miss / error. Bumps last-used (fire-and-forget) on a hit. */
export const getAudioBlob = async (key: string): Promise<Blob | null> => {
  if (!(await audioCacheReady())) return null;
  try {
    const db = await getDB();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(AUDIO, 'readonly');
      const req = tx.objectStore(AUDIO).get(key);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (blob) touch(key);
    return blob;
  } catch (e) {
    warn('🔊 Audio cache: get failed', e);
    return null;
  }
};

/** The cached per-word timings for `key`, or null on miss / error. */
export const getTimings = async (key: string): Promise<WordTiming[] | null> => {
  if (!(await audioCacheReady())) return null;
  try {
    const db = await getDB();
    return await new Promise<WordTiming[] | null>((resolve, reject) => {
      const tx = db.transaction(TIMINGS, 'readonly');
      const req = tx.objectStore(TIMINGS).get(key);
      req.onsuccess = () => resolve((req.result as WordTiming[]) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
};

// ── Writes (write-through; best-effort, never throw) ────────────────────────────
/** Store a clip Blob under `key` and schedule LRU eviction. No-op if the cache is unavailable. */
export const putAudioBlob = async (key: string, blob: Blob): Promise<void> => {
  if (!blob || blob.size === 0) return;
  if (!(await audioCacheReady())) return;
  await writeAudio(key, blob, false);
  scheduleEviction();
};

/** Store per-word timings under `key`. No-op on empty input or unavailable cache. */
export const putTimings = async (key: string, timings: WordTiming[]): Promise<void> => {
  if (!timings || !timings.length) return;
  if (!(await audioCacheReady())) return;
  try {
    const db = await getDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(TIMINGS, 'readwrite');
      tx.objectStore(TIMINGS).put(timings, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
};

// Write the blob + its meta in one transaction. On a quota-exceeded abort, free room once and retry.
const writeAudio = (key: string, blob: Blob, retried: boolean): Promise<void> =>
  new Promise((resolve) => {
    getDB().then((db) => {
      const tx = db.transaction([AUDIO, META], 'readwrite');
      tx.objectStore(AUDIO).put(blob, key);
      tx.objectStore(META).put({ size: blob.size, at: now() } as MetaRecord, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const err = tx.error;
        if (!retried && err && err.name === 'QuotaExceededError') {
          // Free several × this clip (min 50 MB) then retry once; if it still fails we just skip caching it.
          evictBytes(Math.max(blob.size * 4, 50 * 1024 * 1024))
            .then(() => writeAudio(key, blob, true))
            .then(resolve, () => resolve());
        } else {
          resolve();
        }
      };
      tx.onerror = () => { /* onabort follows for quota; nothing else to do */ };
    }).catch(() => resolve());
  });

// ── Eviction (LRU by last-used; runs lazily off the hot path) ────────────────────
let evictScheduled = false;
const scheduleEviction = (): void => {
  if (evictScheduled) return;
  evictScheduled = true;
  const run = () => { evictScheduled = false; void evictToBudget(); };
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 3000);
};

const computeBudget = async (): Promise<number> => {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { quota } = await navigator.storage.estimate();
      if (quota && isFinite(quota)) return Math.min(TARGET_BUDGET_BYTES, Math.floor(quota * QUOTA_FRACTION));
    }
  } catch { /* ignore — use the static target */ }
  return TARGET_BUDGET_BYTES;
};

// Sum stored bytes by scanning META only (tiny records — never touches the audio blobs).
const totalBytes = (db: IDBDatabase): Promise<number> =>
  new Promise((resolve) => {
    let sum = 0;
    const tx = db.transaction(META, 'readonly');
    const cur = tx.objectStore(META).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { sum += (c.value as MetaRecord)?.size || 0; c.continue(); } else resolve(sum);
    };
    cur.onerror = () => resolve(sum);
  });

const evictToBudget = async (): Promise<void> => {
  try {
    const db = await getDB();
    const [budget, total] = await Promise.all([computeBudget(), totalBytes(db)]);
    if (total > budget) await deleteOldest(db, total - budget);
  } catch (e) {
    warn('🔊 Audio cache: eviction failed', e);
  }
};

const evictBytes = async (bytes: number): Promise<void> => {
  try { await deleteOldest(await getDB(), bytes); } catch { /* best-effort */ }
};

// Delete oldest clips (by the meta `by_at` index) until `bytesToFree` have been reclaimed, removing the
// audio blob, its meta, and its timings together so the three stores stay in sync.
const deleteOldest = (db: IDBDatabase, bytesToFree: number): Promise<void> =>
  new Promise((resolve) => {
    if (bytesToFree <= 0) { resolve(); return; }
    let freed = 0;
    const tx = db.transaction([AUDIO, META, TIMINGS], 'readwrite');
    const meta = tx.objectStore(META);
    const audio = tx.objectStore(AUDIO);
    const timings = tx.objectStore(TIMINGS);
    const cur = meta.index(BY_AT).openCursor(); // oldest first
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || freed >= bytesToFree) return; // stop advancing → tx auto-commits → oncomplete resolves
      const key = c.primaryKey as string;
      freed += (c.value as MetaRecord)?.size || 0;
      audio.delete(key);
      meta.delete(key);
      timings.delete(key);
      c.continue();
    };
    cur.onerror = () => resolve();
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  });

// Bump a clip's last-used timestamp so LRU protects recently-played clips. Fire-and-forget.
const touch = (key: string): void => {
  getDB().then((db) => {
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const g = store.get(key);
    g.onsuccess = () => {
      const m = g.result as MetaRecord | undefined;
      if (m) store.put({ size: m.size, at: now() } as MetaRecord, key);
    };
  }).catch(() => { /* best-effort */ });
};

// ── Misc ─────────────────────────────────────────────────────────────────────
/**
 * Ask the browser to mark our storage persistent (best-effort) so it isn't evicted under pressure.
 * Safe no-op where the API is missing or the grant is denied. Call once at app start.
 */
export const requestPersistentStorage = async (): Promise<void> => {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist || !navigator.storage.persisted) return;
    if (await navigator.storage.persisted()) return; // already durable
    const granted = await navigator.storage.persist();
    log(`🔊 Audio cache: persistent storage ${granted ? 'granted' : 'denied'}`);
  } catch { /* ignore */ }
};
