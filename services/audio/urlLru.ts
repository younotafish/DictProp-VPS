import { playingSource } from './player';

// ── Bounded (LRU) caches ───────────────────────────────────────────────────────
// The clip caches once grew WITHOUT BOUND: every unique clip played / prefetched / preloaded stored
// an object-URL that was NEVER revoked, so its audio blob stayed pinned in memory for the life of the
// page. Over a long review/autoplay session (swiping through hundreds of sentences) that steady climb
// could exhaust a mobile tab's memory budget and crash it. These helpers cap each cache and revoke the
// object-URL of anything evicted, so memory plateaus instead of climbing. Map iteration order is
// insertion order, so keys().next() is the oldest; a hit re-inserts to mark it most-recently-used.
export const MAX_TTS_URLS = 200;     // cached MiMo clips (short WAV/MP3 blobs)
export const MAX_KOKORO_URLS = 100;  // in-browser Kokoro clips (desktop only)
export const MAX_TIMINGS = 300;      // per-word timing arrays (no blob → cap only, nothing to revoke)

export const lruTouch = <V>(map: Map<string, V>, key: string): void => {
  const v = map.get(key);
  if (v !== undefined && map.delete(key)) map.set(key, v);
};
// Insert an object-URL under an LRU cap, revoking the URL of anything evicted so its blob is freed —
// EXCEPT the clip the <audio> element is currently using (still needed): for that one we drop only the
// map entry, leaving the element's own reference intact (it's revoked on a later eviction once idle).
export const lruSetUrl = (map: Map<string, string>, key: string, url: string, cap: number): void => {
  map.delete(key);
  map.set(key, url);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const oldUrl = map.get(oldest);
    map.delete(oldest);
    if (oldUrl && oldUrl !== playingSource()) { try { URL.revokeObjectURL(oldUrl); } catch { /* ignore */ } }
  }
};
export const lruSetVal = <V>(map: Map<string, V>, key: string, val: V, cap: number): void => {
  map.delete(key);
  map.set(key, val);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};
