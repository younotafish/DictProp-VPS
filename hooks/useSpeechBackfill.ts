import { useCallback, useRef, useState } from 'react';
import type { JobNotices } from './useJobNotice';

/** How far the watched speech sweep has got, as its pill shows it. */
export interface SpeechProgress { current: number; total: number }

export function useSpeechBackfill({ showJobNotice }: Pick<JobNotices, 'showJobNotice'>) {
  // The watched sweep's progress; null while none is watched.
  const [speechProgress, setSpeechProgress] = useState<SpeechProgress | null>(null);
  // The watch the pill shows. Each watched run has its own, so Hide, or a newer run taking over, ends only that one,
  // and a silent run never touches it.
  const watchRef = useRef<{ stopped: boolean } | null>(null);

  // ── "Generate speech cache" — server-side background backfill ───────────
  // The server makes the Clear and Casual clips, each with word timings, of every sentence in the library (saved
  // sentences and the examples on word and phrase cards) and of both catalogs, entirely on the box
  // (services/speechSweep, which loads with the notebook tools App preloads once the first screen is up).
  // A foreground run watches its progress in the pill; a silent one (after a batch import) only starts it.
  // Either way the result is a job notice (services/jobNotices).
  // `ids`, the items that prompted the run, aren't sent: the server backfills everything, and a clip
  // already made costs nothing. Its identity never changes, so handlers can depend on it.
  const runSpeechGeneration = useCallback(async (_ids: string[], { silent }: { silent: boolean }): Promise<void> => {
    const { runSpeechSweep, describeSpeechResult, retryingPoll, getTtsBackfillStatus } =
      await import('../services/libraryTools');
    const watch = { stopped: false };
    if (!silent) {
      if (watchRef.current) watchRef.current.stopped = true;
      watchRef.current = watch;
    }
    const stopped = () => watch.stopped;
    const outcome = await runSpeechSweep({
      silent,
      onProgress: progress => {
        if (watch.stopped) return;
        setSpeechProgress(progress?.isRunning ? { current: progress.current, total: progress.total } : null);
      },
      stopped,
      // A progress check that fails is tried again a few times before the watch gives up.
      poll: retryingPoll(getTtsBackfillStatus, { stopped }),
    });
    if (watchRef.current === watch) watchRef.current = null;
    const notice = describeSpeechResult(outcome, silent);
    if (notice) showJobNotice(notice);
  }, [showJobNotice]);

  // The pill's Hide: stops watching and takes the pill away; the server's sweep carries on.
  const stopWatchingSpeechGeneration = useCallback(() => {
    if (watchRef.current) watchRef.current.stopped = true;
    watchRef.current = null;
    setSpeechProgress(null);
  }, []);

  // Button handler: sweep ALL items, watched. Wrapped so a click event isn't passed as `ids`.
  const handleGenerateAllSpeech = useCallback(() => { void runSpeechGeneration([], { silent: false }); }, [runSpeechGeneration]);

  return {
    speechProgress, speechGenerationRunning: speechProgress !== null, stopWatchingSpeechGeneration, runSpeechGeneration,
    handleGenerateAllSpeech,
  };
}

export type SpeechBackfill = ReturnType<typeof useSpeechBackfill>;
