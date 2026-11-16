import { useCallback, useRef, useState } from 'react';
import type { SpeechSweepProgress } from '../services/speechSweep';
import type { Overlays } from './useOverlays';

export function useSpeechBackfill({ showNotice }: Pick<Overlays, 'showNotice'>) {
  // Bulk TTS pre-generation sweep progress (null = not running).
  const [ttsGenProgress, setTtsGenProgress] = useState<SpeechSweepProgress | null>(null);
  const ttsGenAbortRef = useRef(false);

  // ── "Generate sentence speech" — server-side background backfill ───────────
  // The server generates MiMo audio + whisper word-timings for EVERY saved sentence, entirely on the box
  // (services/speechSweep, which loads with the notebook tools App preloads once the first screen is up).
  // A foreground run watches its progress in the pill; a silent one (after a batch import) only starts it.
  // `ids`, the items that prompted the run, aren't sent: the server backfills everything, and a clip
  // already made costs nothing. Its identity never changes, so handlers can depend on it.
  const runSpeechGeneration = useCallback(async (_ids: string[], { silent }: { silent: boolean }): Promise<void> => {
    const { runSpeechSweep, describeSweepOutcome } = await import('../services/libraryTools');
    let watching = false;
    const outcome = await runSpeechSweep({
      silent,
      onProgress: progress => {
        // A watch starts with Stop unpressed: the pill's Stop sets the flag for the watch it shows. The first
        // report comes once the start has succeeded, before the sweep first asks whether it was stopped.
        if (!watching) {
          watching = true;
          ttsGenAbortRef.current = false;
        }
        setTtsGenProgress(progress);
      },
      stopped: () => ttsGenAbortRef.current,
    });
    const notice = describeSweepOutcome(outcome, silent);
    if (notice) showNotice(notice);
  }, [showNotice]);

  // Button handler: sweep ALL items, with modals. Wrapped so a click event isn't passed as `ids`.
  const handleGenerateAllSpeech = useCallback(() => { void runSpeechGeneration([], { silent: false }); }, [runSpeechGeneration]);

  return { ttsGenProgress, ttsGenAbortRef, handleGenerateAllSpeech, runSpeechGeneration };
}

export type SpeechBackfill = ReturnType<typeof useSpeechBackfill>;
