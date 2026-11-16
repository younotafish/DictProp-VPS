import type { NoticeTone } from '../components/NoticePill';
import type { BatchImportOutcome } from './batchImport';
import type { SpeechSweepOutcome } from './speechSweep';

/**
 * What the background jobs and sync tell the user, as pills in the notice stack (components/JobPills), never a dialog,
 * since none of it asks for a decision: each job's result and Sync now; and how the speech sweep's watch rides out a
 * failed progress check. It loads with the notebook tools (services/libraryTools) and the pills, so it stays out of
 * the app's first chunk; elsewhere only `import type` from here.
 */

/** A job's result as its pill shows it. */
export interface JobNotice {
  text: string;
  tone: NoticeTone;
  /** How long it shows; null keeps it until it's dismissed or another result replaces it. */
  timeoutMs: number | null;
  /** The words the pill's Retry imports again. */
  retryWords?: string[];
  /** The job the pill's Retry starts again. */
  retry?: 'speech';
}

/** A count as the pills show it: 1,200. */
export const count = (n: number): string => n.toLocaleString('en-US');
const words = (n: number): string => `${count(n)} ${n === 1 ? 'word' : 'words'}`;

/** What a batch import says when it ends. */
export function describeBatchResult(outcome: BatchImportOutcome): JobNotice {
  if (outcome.kind === 'all-saved') {
    const text = outcome.listed === 1 ? 'That word is already saved' : `All ${words(outcome.listed)} are already saved`;
    return { text, tone: 'emerald', timeoutMs: 3_000 };
  }
  const { added, skipped, failed, failedWords } = outcome;
  if (outcome.kind === 'stopped') return { text: `Stopped · added ${words(added)}`, tone: 'dark', timeoutMs: 4_000 };
  if (failed > 0) {
    return { text: `Couldn’t add ${words(failed)}`, tone: 'rose', timeoutMs: null, retryWords: failedWords };
  }
  const summary = added > 0 ? `Added ${words(added)}` : 'Nothing new to add';
  const text = skipped > 0 ? `${summary} · ${count(skipped)} already saved` : summary;
  return { text, tone: 'emerald', timeoutMs: 4_000 };
}

/** What a scan for variant duplicates says when it finds none; with clusters to review, their dialog opens instead. */
export const describeDuplicateScan = (clusterCount: number): JobNotice | null =>
  clusterCount === 0 ? { text: 'No duplicates found', tone: 'emerald', timeoutMs: 3_000 } : null;

/**
 * What the speech sweep says when it ends. A run only started (after a batch import) or a watch the user hid says
 * nothing, and neither does a silent run whose start failed. A watch that lost the server says the sweep carries on
 * there, since only the server knows when it's done.
 */
export function describeSpeechResult(outcome: SpeechSweepOutcome, silent: boolean): JobNotice | null {
  switch (outcome.kind) {
    case 'start-failed':
      if (silent) return null;
      return { text: 'Couldn’t start sentence audio', tone: 'rose', timeoutMs: 6_000, retry: 'speech' };
    case 'finished': {
      const { generated, failed } = outcome.status;
      const text = `Sentence audio ready · ${count(generated)} new${failed > 0 ? ` · ${count(failed)} failed` : ''}`;
      return { text, tone: 'emerald', timeoutMs: 4_000 };
    }
    case 'poll-failed':
      return { text: 'Sentence audio continues on the server', tone: 'dark', timeoutMs: 4_000 };
    case 'started':
    case 'stopped':
      return null;
  }
}

// After a failed progress check, the waits before each new try: about 30 s in all before the watch gives up.
const POLL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/** How long to wait after `failures` failed progress checks in a row before the next try, or null to give up. */
export const nextPollDelay = (failures: number): number | null => POLL_RETRY_DELAYS_MS[failures - 1] ?? null;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The speech sweep's progress check (services/speechSweep's `poll`), made to ride out a short outage: when a check
 * fails it waits nextPollDelay and tries again, and throws the last failure only once the waits run out or the user
 * has stopped watching.
 */
export function retryingPoll<T>(
  poll: () => Promise<T>,
  { stopped, wait = delay }: { stopped: () => boolean; wait?: (ms: number) => Promise<void> },
): () => Promise<T> {
  return async () => {
    for (let failures = 1; ; failures++) {
      try {
        return await poll();
      } catch (error) {
        const pause = nextPollDelay(failures);
        if (pause === null || stopped()) throw error;
        await wait(pause);
        if (stopped()) throw error;
      }
    }
  };
}

/** Where a Sync now has got: still syncing, done, or failed. */
export type ForceSyncPhase = 'syncing' | 'done' | 'failed';

/** What the Sync now pill says; a failed one also offers Retry. */
export const forceSyncText = (phase: ForceSyncPhase): string =>
  phase === 'syncing' ? 'Syncing…' : phase === 'done' ? 'Up to date' : 'Couldn’t sync';
