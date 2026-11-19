// The theme sweep: labels a user's own saved sentences with Today's themes, a batch at a time, one request at a time.
// It starts on its own (a minute after the server starts, half a minute after the last item write, and when
// GET /api/themes finds sentences waiting while it is idle); no client asks for a classification. Its count of the
// sentences still waiting lives in memory: a sweep counts them, and an item write makes the count stale, so the sweep
// counts again before its next batch, never-reviewed sentences first. A provider that keeps failing pauses it.
import { createChatClient, DEEPSEEK_MODEL, type AiError, type ChatJson } from '../ai-client.js';
import {
  deleteNonSentenceThemes,
  listThemeCandidates,
  recordThemeResults,
  type ThemeCandidate,
  type ThemeResult,
} from '../db.js';
import { THEME_TAXONOMY_VERSION, THEMES, type ThemesResponse } from '../shared/item-themes.js';
import { classifyThemeBatch, THEME_BATCH_SIZE } from './classifier.js';

/** What GET /api/themes reports of a user's sweep. */
export type ThemeSweepReport = Pick<ThemesResponse, 'pending' | 'status' | 'lastError'>;

export interface ThemeSweep {
  /**
   * The user's sweep as GET /api/themes reports it. A count that is stale or missing is taken first, and a sweep starts
   * when items are waiting and none is running or paused.
   */
  report(userId: string): Promise<ThemeSweepReport>;
  /** Starts a sweep, unless one is running or the breaker has paused it. */
  trigger(userId: string): void;
  /** An item write: the count is stale, and a sweep starts once writes have stopped for the write delay. */
  noteItemWrite(userId: string): void;
  /** Triggers each of these users' sweeps after the startup delay, as the server starts. */
  startAfterDelay(userIds: () => readonly string[]): void;
  /** Stops for good, as the server shuts down: aborts the requests under way, drops the timers, records nothing more. */
  stop(): void;
  /** Resolves once the user's sweep, if one is running, has stopped. */
  idle(userId: string): Promise<void>;
}

export interface ThemeSweepOptions {
  chat?: ChatJson;
  /** Recorded with each theme. */
  model?: string;
  now?: () => number;
  /** Runs `run` after `ms`, and returns what cancels it; tests keep the clock. */
  setTimer?: (run: () => void, ms: number) => () => void;
  batchSize?: number;
  startupDelayMs?: number;
  writeDelayMs?: number;
  pauseMs?: number;
}

/** After the server starts: past the deploy's health check, and clear of the first requests. */
const STARTUP_DELAY_MS = 60_000;
/** After the last item write, so a burst of saves is labelled together. */
const WRITE_DELAY_MS = 30_000;
/** How long the breaker holds the sweep once it trips. */
const PAUSE_MS = 15 * 60_000;
/** Failed batches in a row, sweeps between included, that trip the breaker. */
const FAILED_BATCHES_TO_PAUSE = 3;

/** A timer that doesn't keep the process alive. */
const unrefTimer = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Why the breaker tripped, in words the owner can act on. */
function pauseReason(error: AiError | undefined): string {
  if (error?.kind === 'quota') return 'The AI provider\'s balance is used up.';
  if (error?.kind === 'auth') return 'The AI provider refused the key, or none is set.';
  if (error) return `The AI service failed three batches in a row (${error.kind}).`;
  return 'The classifier gave no usable themes for three batches in a row.';
}

interface UserSweep {
  /** The sweep running now. */
  running?: Promise<void>;
  /** The sentences counted and not yet sent, never-reviewed first, each group newest first. */
  queue?: ThemeCandidate[];
  /** The sentences still waiting for a theme: the last count, less what has been labelled since. */
  pending?: number;
  /** An item was written since the count. */
  stale: boolean;
  counting?: Promise<void>;
  failedInARow: number;
  pausedUntil: number;
  lastError?: string;
  cancelWriteTimer?: () => void;
}

export function createThemeSweep({
  chat = createChatClient(),
  model = DEEPSEEK_MODEL,
  now = Date.now,
  setTimer = unrefTimer,
  batchSize = THEME_BATCH_SIZE,
  startupDelayMs = STARTUP_DELAY_MS,
  writeDelayMs = WRITE_DELAY_MS,
  pauseMs = PAUSE_MS,
}: ThemeSweepOptions = {}): ThemeSweep {
  const users = new Map<string, UserSweep>();
  const themeIds = new Set(THEMES.map(theme => theme.id));
  const shutdown = new AbortController();
  let cancelStartup: (() => void) | undefined;

  const userSweep = (userId: string): UserSweep => {
    let sweep = users.get(userId);
    if (!sweep) users.set(userId, sweep = { stale: true, failedInARow: 0, pausedUntil: 0 });
    return sweep;
  };
  const paused = (sweep: UserSweep) => now() < sweep.pausedUntil;

  /**
   * Counts the sentences waiting for a theme into the queue; a count already under way is shared. The theme rows of
   * items that aren't sentences are deleted first, so the words labelled while Today still took words leave the table
   * on the first count after the server starts.
   */
  const count = (userId: string, sweep: UserSweep): Promise<void> => {
    sweep.counting ??= (async () => {
      // A write from here on makes this count stale.
      sweep.stale = false;
      const deleted = deleteNonSentenceThemes(userId);
      if (deleted > 0) console.log(`[themes] deleted the theme rows of ${deleted} items that are not sentences`);
      sweep.queue = await listThemeCandidates(userId, THEME_TAXONOMY_VERSION, themeIds, shutdown.signal);
      sweep.pending = sweep.queue.length;
    })().finally(() => { sweep.counting = undefined; });
    return sweep.counting;
  };

  /**
   * Trips the breaker: the sweep stops, and no trigger starts another until the pause is over. That one counts afresh,
   * so it begins with the items of the batches that failed.
   */
  const pause = (sweep: UserSweep, error: AiError | undefined) => {
    sweep.pausedUntil = now() + pauseMs;
    sweep.queue = undefined;
    sweep.lastError = pauseReason(error);
    console.warn(`[themes] sweep paused for ${Math.round(pauseMs / 60_000)} min: ${sweep.lastError}${error ? ` ${error.message}` : ''}`);
  };

  /** Labels one batch and records it. False when the sweep must stop: shut down, or paused by the breaker. */
  const labelBatch = async (userId: string, sweep: UserSweep, batch: readonly ThemeCandidate[]): Promise<boolean> => {
    const result = await classifyThemeBatch(batch.map(candidate => candidate.item), chat, { signal: shutdown.signal });
    if (shutdown.signal.aborted) return false;
    const unanswered = new Set(result.unanswered);
    const results: ThemeResult[] = batch.flatMap(({ itemId, inputHash }, position) => {
      const themeId = result.themes[position];
      return themeId !== null || unanswered.has(position) ? [{ itemId, inputHash, themeId }] : [];
    });
    const themed = results.filter(entry => entry.themeId !== null).length;
    const { exhausted } = results.length === 0
      ? { exhausted: 0 }
      : recordThemeResults(userId, results, { model, taxonomyVersion: THEME_TAXONOMY_VERSION, now: now() });
    sweep.pending = Math.max(0, (sweep.pending ?? 0) - themed - exhausted);
    // A spent balance or a refused key won't mend by asking again; anything else trips the breaker only when it keeps
    // happening.
    if (result.error?.kind === 'quota' || result.error?.kind === 'auth') {
      pause(sweep, result.error);
      return false;
    }
    sweep.failedInARow = result.error || themed === 0 ? sweep.failedInARow + 1 : 0;
    if (sweep.failedInARow < FAILED_BATCHES_TO_PAUSE) return true;
    pause(sweep, result.error);
    return false;
  };

  const run = async (userId: string, sweep: UserSweep) => {
    try {
      for (;;) {
        if (!sweep.queue || sweep.stale) await count(userId, sweep);
        if (shutdown.signal.aborted) return;
        const batch = sweep.queue?.splice(0, batchSize) ?? [];
        if (batch.length === 0) break;
        if (!await labelBatch(userId, sweep, batch)) return;
      }
      // The next sweep counts afresh, so it asks again about the items this one's batches missed.
      sweep.queue = undefined;
      sweep.lastError = undefined;
    } catch (error) {
      sweep.queue = undefined;
      sweep.lastError = 'Sorting stopped on an error, and starts again with the next save.';
      console.error('[themes] sweep failed:', error);
    }
  };

  const trigger = (userId: string) => {
    if (shutdown.signal.aborted) return;
    const sweep = userSweep(userId);
    if (sweep.running || paused(sweep)) return;
    sweep.running = run(userId, sweep).finally(() => { sweep.running = undefined; });
  };

  return {
    async report(userId) {
      const sweep = userSweep(userId);
      if (!shutdown.signal.aborted && !sweep.running) {
        if (sweep.pending === undefined || sweep.stale) {
          if (paused(sweep)) await count(userId, sweep);
          else trigger(userId);
        } else if (sweep.pending > 0) {
          trigger(userId);
        }
      }
      // A count under way, this report's or a sweep's, is waited for, so the number is current.
      await sweep.counting;
      const pending = sweep.pending ?? 0;
      const status = paused(sweep) ? 'paused' : sweep.running && pending > 0 ? 'running' : 'idle';
      return { pending, status, ...(sweep.lastError ? { lastError: sweep.lastError } : {}) };
    },

    trigger,

    noteItemWrite(userId) {
      if (shutdown.signal.aborted) return;
      const sweep = userSweep(userId);
      sweep.stale = true;
      sweep.cancelWriteTimer?.();
      sweep.cancelWriteTimer = setTimer(() => {
        sweep.cancelWriteTimer = undefined;
        trigger(userId);
      }, writeDelayMs);
    },

    startAfterDelay(userIds) {
      cancelStartup?.();
      cancelStartup = setTimer(() => {
        cancelStartup = undefined;
        for (const userId of userIds()) trigger(userId);
      }, startupDelayMs);
    },

    stop() {
      shutdown.abort();
      cancelStartup?.();
      for (const sweep of users.values()) sweep.cancelWriteTimer?.();
    },

    async idle(userId) {
      await users.get(userId)?.running;
    },
  };
}

/** The server's sweep: GET /api/themes reports it and item writes nudge it (app.ts); index.ts starts and stops it. */
export const themeSweep = createThemeSweep();
