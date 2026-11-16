import { getTtsBackfillStatus, startTtsBackfill, type TtsBackfillStatus } from './api/tts';

/**
 * The speech sweep: the server generates the clip and word timings of every saved sentence on the box (idempotent
 * and resumable, so the app needn't stay open), and the app can watch its progress. It loads with import(), through
 * services/libraryTools, so its polling, its texts and the speech-server client stay out of the first chunk; the
 * hook that runs it (hooks/useSpeechBackfill) imports only its types.
 */

/** How far the watched sweep has got, as the progress pill shows it. */
export interface SpeechSweepProgress { current: number; total: number; isRunning: boolean }

/**
 * How a sweep ended for the app: its start failed; it was started silently and not watched; the server finished it;
 * the user stopped watching it (the server carries on); or a progress check failed, which ends the watch. `status`
 * is the server's last report, absent only when the start failed.
 */
export type SpeechSweepOutcome =
  | { kind: 'start-failed'; status?: undefined }
  | { kind: 'started' | 'finished' | 'stopped' | 'poll-failed'; status: TtsBackfillStatus };

export interface SpeechSweepRun {
  /** Only start the sweep, without watching it (after a batch import). */
  silent: boolean;
  /**
   * Hears the watched sweep's progress: first the snapshot the start returned, before stopped() is first asked,
   * then each check's, and null when the watch ends. A silent run, or one whose start failed, reports nothing.
   */
  onProgress: (progress: SpeechSweepProgress | null) => void;
  /** Whether the user has stopped watching. Asked before each wait, and once more when the watch ends. */
  stopped: () => boolean;
  /** Starts the server's sweep; tests pass their own. */
  start?: () => Promise<TtsBackfillStatus>;
  /** Reads the server's progress; tests pass their own. */
  poll?: () => Promise<TtsBackfillStatus>;
  /** Waits between progress checks; tests pass one that doesn't. */
  wait?: (ms: number) => Promise<void>;
}

// The pause before each progress check while the sweep is watched.
const POLL_INTERVAL_MS = 3_000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Starts the server's speech sweep and, unless the run is silent, watches it until it ends or the user stops watching. */
export async function runSpeechSweep({
  silent, onProgress, stopped, start = startTtsBackfill, poll = getTtsBackfillStatus, wait = delay,
}: SpeechSweepRun): Promise<SpeechSweepOutcome> {
  let status: TtsBackfillStatus;
  try {
    status = await start();
  } catch {
    return { kind: 'start-failed' };
  }
  if (silent) return { kind: 'started', status };

  onProgress({ current: status.done, total: status.total, isRunning: true });
  let pollFailed = false;
  while (!stopped()) {
    await wait(POLL_INTERVAL_MS);
    try {
      status = await poll();
    } catch {
      pollFailed = true;
      break;
    }
    onProgress({ current: status.done, total: status.total, isRunning: !!status.running });
    if (!status.running) break;
  }
  onProgress(null);
  // A Stop pressed while the last check ran still counts, even when that check found the sweep finished.
  return { kind: stopped() ? 'stopped' : pollFailed ? 'poll-failed' : 'finished', status };
}
