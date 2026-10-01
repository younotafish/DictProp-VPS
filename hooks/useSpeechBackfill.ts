import { useCallback, useRef, useState } from 'react';
import { getTtsBackfillStatus, startTtsBackfill } from '../services/api';
import type { Overlays } from './useOverlays';

export function useSpeechBackfill({ setConfirmModal }: Pick<Overlays, 'setConfirmModal'>) {
  // Bulk TTS pre-generation sweep progress (null = not running).
  const [ttsGenProgress, setTtsGenProgress] = useState<{ current: number; total: number; isRunning: boolean } | null>(null);
  const ttsGenAbortRef = useRef(false);

  // ── "Generate sentence speech" — server-side background backfill ───────────
  // Triggers the server to generate MiMo audio + whisper word-timings for EVERY saved sentence,
  // entirely on the box (idempotent + resumable) — the app does NOT need to stay open. Foreground
  // calls poll progress into the bar; `silent` (post-batch-import) just fires it. `itemIds` is ignored
  // now (the server backfills everything; idempotent so it costs nothing for already-done clips).
  const runSpeechGeneration = useCallback(async (_itemIds?: string[], opts?: { silent?: boolean }) => {
    let status;
    try {
      status = await startTtsBackfill();
    } catch {
      if (!opts?.silent) setConfirmModal({ isOpen: true, title: "Couldn't Start", message: 'Failed to reach the server to start generation.', confirmText: 'OK', variant: 'warning', onConfirm: () => setConfirmModal(null), showCancel: false });
      return;
    }
    if (opts?.silent) return; // background trigger — the server handles it; no UI, app can close.

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

  // Button handler: sweep ALL items, with modals. Wrapped so a click event isn't passed as `itemIds`.
  const handleGenerateAllSpeech = useCallback(() => { void runSpeechGeneration(); }, [runSpeechGeneration]);
  // Ref so handleBatchImport (declared with empty deps) can fire the post-import sweep.
  const runSpeechGenerationRef = useRef(runSpeechGeneration);
  runSpeechGenerationRef.current = runSpeechGeneration;

  return { ttsGenProgress, ttsGenAbortRef, handleGenerateAllSpeech, runSpeechGenerationRef };
}

export type SpeechBackfill = ReturnType<typeof useSpeechBackfill>;
