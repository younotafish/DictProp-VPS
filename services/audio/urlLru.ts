// ── Bounded (LRU) caches ───────────────────────────────────────────────────────
// The clip caches once grew WITHOUT BOUND: every unique clip played / prefetched / preloaded stored
// an object-URL that was NEVER revoked, so its audio blob stayed pinned in memory for the life of the
// page. Over a long review/autoplay session (swiping through hundreds of sentences) that steady climb
// could exhaust a mobile tab's memory budget and crash it. These caches are capped, and the clip caches
// revoke the object-URL of anything evicted, so memory plateaus instead of climbing.
export const MAX_TTS_URLS = 200;     // cached MiMo clips (short WAV/MP3 blobs)
export const MAX_KOKORO_URLS = 100;  // in-browser Kokoro clips (never on iOS/iPadOS)
export const MAX_TIMINGS = 300;      // per-word timing arrays (no blob → cap only, nothing to revoke)

/** A map capped at `cap` entries that evicts the least recently used one; a read or a write marks an entry used. */
export class Lru<V> {
  // Map iteration follows insertion order, so the first key is the least recently used.
  private readonly entries = new Map<string, V>();

  constructor(private readonly cap: number, private readonly onEvict?: (value: V) => void) {}

  get size(): number { return this.entries.size; }

  /** Whether `key` is cached, without counting as a use. */
  has(key: string): boolean { return this.entries.has(key); }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    const replaced = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    if (replaced !== undefined && replaced !== value) this.onEvict?.(replaced);
    for (const [oldest, evicted] of this.entries) {
      if (this.entries.size <= this.cap) break;
      this.entries.delete(oldest);
      this.onEvict?.(evicted);
    }
  }
}

// The object URL the shared <audio> element is set to, and URLs evicted while it was: revoking those would cut
// off the clip it's playing, so they're revoked once the element moves to another source.
let urlInUse: string | null = null;
const evictedWhileInUse = new Set<string>();

const revoke = (url: string): void => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
const release = (url: string): void => {
  if (url === urlInUse) evictedWhileInUse.add(url);
  else revoke(url);
};

/** The player calls this whenever it points the shared <audio> element at a new source. */
export const setUrlInUse = (url: string | null): void => {
  urlInUse = url;
  for (const evicted of evictedWhileInUse) {
    if (evicted === url) continue;
    evictedWhileInUse.delete(evicted);
    revoke(evicted);
  }
};

/** An Lru of object URLs that revokes what it evicts, except the URL the <audio> element is using, which waits. */
export class UrlLru extends Lru<string> {
  constructor(cap: number) {
    super(cap, release);
  }
}
