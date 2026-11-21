/**
 * How the review history (the study dashboard's numbers, and Today's goal and streak) is loaded: how far back a load
 * takes reviews in full, how a loaded history joins what this device already holds, and when to load it again.
 * hooks/useReviewHistory.ts imports it when it first loads, so none of it is in the app's first chunk.
 */
import type { ReviewEvent, ReviewHistory } from '../types';

const DAY_MS = 86_400_000;
/** Reviews come in full for the week the dashboard's weekly numbers cover, plus a day. */
export const RECENT_DAYS = 8;
/** How old a loaded history may get before coming back online or into view loads it again. */
export const HISTORY_RELOAD_AFTER_MS = 15 * 60_000;

/** The history and whether a load of it has succeeded yet; until one has, the dashboard shows '—' for its numbers. */
export type LoadedReviewHistory = ReviewHistory & { loaded: boolean };

/** How the last load that finished went: whether it succeeded, and when. */
export interface HistoryLoad {
  ok: boolean;
  at: number;
}

const byTime = (a: ReviewEvent, b: ReviewEvent) => a.reviewedAt - b.reviewedAt;

/**
 * Where a load's full reviews begin, `now` being when it starts: a week and a day back, or further, to the oldest
 * review still in the outbox (`pending`), so a review the outbox delivers meanwhile can't come back as an older
 * review as well.
 */
export function recentSinceFor(pending: readonly ReviewEvent[], now: number): number {
  let recentSince = now - RECENT_DAYS * DAY_MS;
  for (const event of pending) if (event.reviewedAt < recentSince) recentSince = event.reviewedAt;
  return recentSince;
}

/**
 * The loaded history (`remote`) with the reviews only this device can know of: those in the outbox when the load
 * began (`pendingIds`), which may not have reached the server, and those made since it began (`loadStartedAt`). The
 * rest of `current` is the server's to report, so a reload counts no review twice (once in full and once among the
 * older times, when the new load's full reviews begin later) and drops one undone on another device. This device's
 * copy of a review wins.
 */
export function mergeLoadedHistory(
  current: ReviewHistory,
  remote: ReviewHistory,
  pendingIds: ReadonlySet<string>,
  loadStartedAt: number,
): ReviewHistory {
  const recent = new Map(remote.recent.map(event => [event.id, event]));
  for (const event of current.recent) {
    if (pendingIds.has(event.id) || event.reviewedAt >= loadStartedAt) recent.set(event.id, event);
  }
  return { recent: [...recent.values()].sort(byTime), olderTimes: remote.olderTimes, olderCount: remote.olderCount };
}

/**
 * Whether the history should load again: no load has finished, the last one failed (an offline start), or it's older
 * than `maxAgeMs`, so the reviews made on other devices since arrive. Coming back online or into view waits a quarter of
 * an hour; a screen that shows what other devices study asks for less (startHistoryLoads' refresh).
 */
export function shouldReloadHistory(lastLoad: HistoryLoad | null, now: number, maxAgeMs = HISTORY_RELOAD_AFTER_MS): boolean {
  return !lastLoad || !lastLoad.ok || now - lastLoad.at > maxAgeMs;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** What the history's loads need from the app and the page. */
export interface HistoryLoadContext {
  /** The reviews still in the outbox, read as each load starts. */
  pending: () => readonly ReviewEvent[];
  /** Fetches the history with reviews in full from `recentSince` on (loadReviewHistory). */
  fetch: (recentSince: number) => Promise<ReviewHistory>;
  /** Applies a successful load to the history held, through `merge`. */
  update: (merge: (current: LoadedReviewHistory) => LoadedReviewHistory) => void;
  /** Hears why a load failed. */
  onError: (error: unknown) => void;
  /** Where 'online' fires (the window), and the page whose visibility changes (the document). */
  online: Listenable;
  page: Listenable & { readonly visibilityState: DocumentVisibilityState };
  now?: () => number;
}

/** The history's loads once started: a refresh asked for, and the stop. */
export interface HistoryLoads {
  /**
   * Loads the history again if the last load failed or is older than `maxAgeMs`, and no load is under way: so a screen
   * can ask whenever it shows, and as often as it likes, without loading the history over and over.
   */
  refresh(maxAgeMs: number): void;
  /** After this no load changes the history, and nothing more loads. */
  stop(): void;
}

/**
 * Loads the history now, and again when the page comes back online or into view once the last load failed or is a
 * quarter of an hour old, or when asked (refresh). Only the latest load counts, so one a later load overtook changes
 * nothing.
 */
export function startHistoryLoads(context: HistoryLoadContext): HistoryLoads {
  const now = context.now ?? Date.now;
  let latest = 0;
  let stopped = false;
  let loading = false;
  let lastLoad: HistoryLoad | null = null;
  const load = () => {
    const run = ++latest;
    loading = true;
    const startedAt = now();
    const pending = context.pending();
    context.fetch(recentSinceFor(pending, startedAt)).then(remote => {
      if (stopped || run !== latest) return;
      loading = false;
      lastLoad = { ok: true, at: now() };
      const pendingIds = new Set(pending.map(event => event.id));
      context.update(current => ({ ...mergeLoadedHistory(current, remote, pendingIds, startedAt), loaded: true }));
    }, error => {
      if (stopped || run !== latest) return;
      loading = false;
      lastLoad = { ok: false, at: now() };
      context.onError(error);
    });
  };
  const reloadIfStale = () => { if (shouldReloadHistory(lastLoad, now())) load(); };
  const reloadIfShown = () => { if (context.page.visibilityState === 'visible') reloadIfStale(); };

  load();
  context.online.addEventListener('online', reloadIfStale);
  context.page.addEventListener('visibilitychange', reloadIfShown);
  return {
    refresh: maxAgeMs => {
      if (!stopped && !loading && shouldReloadHistory(lastLoad, now(), maxAgeMs)) load();
    },
    stop: () => {
      stopped = true;
      context.online.removeEventListener('online', reloadIfStale);
      context.page.removeEventListener('visibilitychange', reloadIfShown);
    },
  };
}
