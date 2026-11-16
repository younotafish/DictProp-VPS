import { useCallback, useRef, useState } from 'react';
import { getTtsBackfillStatus, startTtsBackfill } from '../services/api/tts';
import type { Overlays } from './useOverlays';

export function useSpeechBackfill({ setConfirmModal }: Pick<Overlays, 'setConfirmModal'>) {
  // Bulk TTS pre-generation sweep progress (null = not running).
  const [ttsGenProgress, setTtsGenProgress] = useState<{ current: number; total: number; isRunning: boolean } | null>(null);
  const ttsGenAbortRef = useRef(false);

  // ── "Generate sentence speech" — server-side background backfill ───────────
  // Triggers the server to generate MiMo audio + whisper word-timings for EVERY saved sentence,
  // entirely on the box (idempotent + resumable) — the app does NOT need to stay open. Foreground
  // calls poll progress into the bar; `silent` (post-batch-import) just fires it. `ids`, the items
  // that prompted the run, aren't sent: the server backfills everything, and a clip already made
  // costs nothing. Its identity never changes, so handlers can depend on it.
  const runSpeechGeneration = useCallback(async (_ids: string[], { silent }: { silent: boolean }): Promise<void> => {
    let status;
    try {
      status = await startTtsBackfill();
    } catch {
      if (!silent) setConfirmModal({ isOpen: true, title: "Couldn't Start", message: 'Failed to reach the server to start generation.', confirmText: 'OK', variant: 'warning', onConfirm: () => setConfirmModal(null), showCancel: false });
      return;
    }
    if (silent) return; // background trigger — the server handles it; no UI, app can close.

    // Foreground: poll the server job's progress. Closing the app does NOT stop the server.
    ttsGenAbortRef.current = false;
    setTtsGenProgress({ current: status.done, total: status.total, isRunning: true });
    let last = status;
    while (!ttsGenAbortRef.current) {
      await new Promise(r => setTimeout(r, 3000));
      try { last = await getTtsBackfillStatus(); } catch { break; }
      setTtsGenProgress({ current: last.done, total: last.total, isRunning: !!last.running });
      if (!last.running) break;
    }
    setTtsGenProgress(null);
    if (!ttsGenAbortRef.current) setConfirmModal({
      isOpen: true,
      title: 'Speech Generated',
      message: `${last.generated} generated · ${Math.max(0, last.total - last.generated - last.failed)} already cached${last.failed ? `\n${last.failed} failed` : ''}`,
      confirmText: 'OK', variant: 'success', onConfirm: () => setConfirmModal(null), showCancel: false,
    });
  }, []);

  // Button handler: sweep ALL items, with modals. Wrapped so a click event isn't passed as `ids`.
  const handleGenerateAllSpeech = useCallback(() => { void runSpeechGeneration([], { silent: false }); }, [runSpeechGeneration]);

  return { ttsGenProgress, ttsGenAbortRef, handleGenerateAllSpeech, runSpeechGeneration };
}

export type SpeechBackfill = ReturnType<typeof useSpeechBackfill>;
