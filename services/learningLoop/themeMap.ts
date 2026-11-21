import type { ThemesResponse } from '../../server/src/shared/item-themes';
import { META_STORE, requestResult, transactionDone, withDB } from '../idb';
import type { LoopPlan } from './planner';

// The theme each of the learner's sentences belongs to, as the server's classifier assigned it (GET /api/themes), kept
// on this device in the library database's META store, so Today plans at once and offline, and each refresh asks only
// for the rows changed since the last. Ids this build's taxonomy doesn't know stay in the map: the planner counts their
// sentences as Unsorted. A map kept from before Today took sentences only also holds rows for words, which nothing
// reads: the planner looks up only the sentences Today takes. The store holds a plain object under its own key; no
// database version change is needed.

/** How often a refresh runs again while the server is still sorting sentences into themes, or after one failed. */
export const THEME_POLL_MS = 60_000;
/**
 * How often a refresh runs while the server has nothing waiting to sort, so a sentence saved since, here or on another
 * device, gets its theme: the server sorts it half a minute after the save reaches it.
 */
export const THEME_IDLE_POLL_MS = 5 * 60_000;

/** The map in memory: item id to theme id, and where the server's change sequence stood. */
export interface ThemeState {
  taxonomyVersion: number;
  latestSeq: number;
  themes: ReadonlyMap<string, string>;
}

/** How the server's sorting stands, from the last refresh. */
export type ThemeSorting = Pick<ThemesResponse, 'pending' | 'status' | 'lastError'>;

/** What the store keeps, as GET /api/themes describes it. */
interface StoredThemes {
  taxonomyVersion: number;
  latestSeq: number;
  map: Record<string, string>;
}

/** Where the map is kept: the META store (idbThemeStore), or a fake in tests. */
export interface ThemeStore {
  read(userId: string): Promise<unknown>;
  write(userId: string, value: StoredThemes): Promise<void>;
}

const themesKey = (userId: string) => `themes_v1_${userId}`;

export const idbThemeStore: ThemeStore = {
  read: userId => withDB(db => requestResult(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(themesKey(userId)))),
  write: (userId, value) => withDB(db => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value, themesKey(userId));
    return transactionDone(tx);
  }),
};

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The stored map as a state, when it is well formed; null otherwise. */
function decodeStored(value: unknown): ThemeState | null {
  if (!value || typeof value !== 'object') return null;
  const { taxonomyVersion, latestSeq, map } = value as Record<string, unknown>;
  if (!isCount(taxonomyVersion) || !isCount(latestSeq) || !map || typeof map !== 'object' || Array.isArray(map)) return null;
  const themes = new Map<string, string>();
  for (const [itemId, themeId] of Object.entries(map)) {
    if (typeof themeId !== 'string') return null;
    themes.set(itemId, themeId);
  }
  return { taxonomyVersion, latestSeq, themes };
}

/** The map kept on this device for `userId`, or null when there is none, it's damaged, or the store can't be read. */
export async function loadCachedThemes(userId: string, store: ThemeStore = idbThemeStore): Promise<ThemeState | null> {
  try {
    return decodeStored(await store.read(userId));
  } catch {
    return null;
  }
}

/** `themes` with the server's changed rows applied in order: a theme id sets the item's, null takes its theme away. */
export function applyThemeRows(themes: ReadonlyMap<string, string>, rows: ThemesResponse['rows']): Map<string, string> {
  const next = new Map(themes);
  for (const [itemId, themeId] of rows) {
    if (themeId === null) next.delete(itemId);
    else next.set(itemId, themeId);
  }
  return next;
}

/**
 * The map brought up to date: the rows changed since `current.latestSeq`, or every row when there is no map yet, the
 * server's taxonomy changed, or its sequence went back (a database restored from a backup). The result is written to
 * the store only when it changed, and a write that fails leaves the map in memory. `current` itself comes back when
 * nothing changed, so a plan built on it stays. A failed request rejects.
 */
export async function refreshThemes(
  userId: string,
  current: ThemeState | null,
  fetchThemes: (after: number) => Promise<ThemesResponse>,
  store: ThemeStore = idbThemeStore,
): Promise<{ state: ThemeState; sorting: ThemeSorting }> {
  let base = current;
  let response = await fetchThemes(base?.latestSeq ?? 0);
  if (base && (response.taxonomyVersion !== base.taxonomyVersion || response.latestSeq < base.latestSeq)) {
    base = null;
    response = await fetchThemes(0);
  }
  const sorting: ThemeSorting = {
    pending: response.pending,
    status: response.status,
    ...(response.lastError !== undefined ? { lastError: response.lastError } : {}),
  };
  if (base && response.rows.length === 0 && response.latestSeq === base.latestSeq) return { state: base, sorting };
  const state: ThemeState = {
    taxonomyVersion: response.taxonomyVersion,
    latestSeq: response.latestSeq,
    themes: applyThemeRows(base?.themes ?? new Map(), response.rows),
  };
  try {
    await store.write(userId, { taxonomyVersion: state.taxonomyVersion, latestSeq: state.latestSeq, map: Object.fromEntries(state.themes) });
  } catch {
    // Storage full or unavailable: the map lasts for this visit, and the next launch fetches every row again.
  }
  return { state, sorting };
}

/** How far the server's sorting has got, as a whole percentage: `sorted` sentences have a theme, `pending` wait for one. */
export function sortingPercent(sorted: number, pending: number): number {
  return sorted + pending > 0 ? Math.floor((sorted / (sorted + pending)) * 100) : 100;
}

/**
 * How far the server's sorting has got, while it still has sentences to sort; null otherwise. What it has sorted is the
 * plan's count of Today's sentences in a known theme (each theme's total), never the map's size: a map kept from before
 * Today took sentences only also holds rows for thousands of words.
 */
export function sortingProgress(plan: Pick<LoopPlan, 'themes'>, sorting: Pick<ThemeSorting, 'pending'> | null): number | null {
  if (!sorting || sorting.pending <= 0) return null;
  let sorted = 0;
  for (const theme of plan.themes.values()) sorted += theme.total;
  return sortingPercent(sorted, sorting.pending);
}

export interface ThemeSyncOptions {
  userId: string;
  fetchThemes: (after: number) => Promise<ThemesResponse>;
  store?: ThemeStore;
  /** Hears the map (first as kept on the device, then after each refresh) and, after a refresh, the sorting status.
   *  The same state object comes back while the map hasn't changed. */
  onUpdate: (state: ThemeState | null, sorting: ThemeSorting | null) => void;
  onError?: (error: unknown) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** The theme map kept current while Today shows: start when it shows, stop when it hides. */
export interface ThemeSync {
  start(): void;
  stop(): void;
}

/**
 * Keeps the theme map current while started: the map kept on the device first (or the one held, when started again),
 * then a refresh, and another every minute while the server still has sentences to sort, or after a failed refresh
 * (offline, say), and every five minutes otherwise. A refresh that brings no change reports the same state object, so
 * nothing built on it is redone. Only the latest start's refreshes are heard, and nothing once stopped.
 */
export function createThemeSync({
  userId, fetchThemes, store = idbThemeStore, onUpdate, onError,
  setTimer = (run, ms) => setTimeout(run, ms), clearTimer = timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ThemeSyncOptions): ThemeSync {
  let state: ThemeState | null = null;
  let sorting: ThemeSorting | null = null;
  let loaded = false;
  let generation = 0;
  let timer: unknown;

  const refresh = async (started: number) => {
    let delay = THEME_POLL_MS;
    try {
      const result = await refreshThemes(userId, state, fetchThemes, store);
      if (started !== generation) return;
      ({ state, sorting } = result);
      if (sorting.pending <= 0) delay = THEME_IDLE_POLL_MS;
      onUpdate(state, sorting);
    } catch (error) {
      if (started !== generation) return;
      onError?.(error);
    }
    // Only the latest start polls: a stop or a new start while this refresh was reported leaves no timer behind.
    if (started === generation) timer = setTimer(() => void refresh(started), delay);
  };

  return {
    start() {
      const started = ++generation;
      clearTimer(timer);
      if (loaded) {
        onUpdate(state, sorting);
        void refresh(started);
        return;
      }
      void loadCachedThemes(userId, store).then(cached => {
        if (started !== generation) return;
        if (!loaded) {
          state = cached;
          loaded = true;
        }
        onUpdate(state, null);
        return refresh(started);
      });
    },
    stop() {
      generation++;
      clearTimer(timer);
    },
  };
}
