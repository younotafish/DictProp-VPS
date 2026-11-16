import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { runPool } from '../server/src/shared/pool';
import { preloadAudio } from '../services/neuralTts';
import { getStoredImageIds } from '../services/imageStore';
import type { PreloadPlan } from '../services/audio/autoplayPreload';
import { useLatest } from '../hooks/useStableValue';
import { NoticePill } from './NoticePill';
import { useNoticeSlot } from './noticeSlots';

interface SessionPreloadProps {
  /** Sentence auto-play is on; turning it off stops what's left. */
  active: boolean;
  /** What the session can reach (views/detail/useAutoplayPreloadPlan.ts). A new plan stops the last one's downloads
   *  and starts its own, which finds what's already stored at once. */
  plan: PreloadPlan | null;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
}

const IMAGE_CONCURRENCY = 4;

/**
 * While sentence auto-play runs, preloads the part of the list it can reach, so a poor or unstable network can't
 * interrupt it: each planned sentence's audio and timings in the voice it will play in (into IndexedDB, a few at a
 * time), and the planned cards' pictures. Best-effort and cancellable; failures still advance the progress, so it
 * always completes. Its 'Preloading k/N' notice goes into the notice stack's progress slot (components/AppStatus),
 * and keeps its state here, so the card doesn't re-render for every clip and picture that arrives.
 */
export function SessionPreload({ active, plan, onLazyLoadImage }: SessionPreloadProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const onLazyLoadImageRef = useLatest(onLazyLoadImage);
  const slot = useNoticeSlot('progress');

  useEffect(() => {
    if (!active || !plan) return;
    let cancelled = false;
    const stop = new AbortController();
    const loadImage = onLazyLoadImageRef.current;
    const ids = loadImage ? [...plan.images.keys()] : [];

    let audioDone = 0;
    let audioTotal = 0;
    let imageDone = 0;
    const report = () => {
      if (cancelled) return;
      const done = audioDone + imageDone;
      const total = audioTotal + ids.length;
      setProgress(done >= total ? null : { done, total });
    };

    // Audio: one progress-reporting batch, which dedupes and generates what's missing itself (its first report, at
    // once, gives the count). Once it settles the audio part is done, even when the speech engine couldn't load, so
    // the notice never sticks.
    preloadAudio(plan.clips, (done, total) => { audioDone = done; audioTotal = total; report(); }, { intoMemory: false, signal: stop.signal })
      .catch(() => {})
      .then(() => { audioDone = audioTotal; report(); });

    // Pictures already in IndexedDB only need an existence check (opening each would churn the memory
    // cache); the rest download a few at a time.
    (async () => {
      if (!loadImage || ids.length === 0) return;
      const expected = new Map<string, string>();
      for (const [id, version] of plan.images) if (version) expected.set(id, version);
      const stored = await getStoredImageIds(ids, expected);
      if (cancelled) return;
      const missing = ids.filter(id => !stored.has(id));
      imageDone = ids.length - missing.length;
      report();
      await runPool(missing, IMAGE_CONCURRENCY, async (id) => {
        try {
          await loadImage(id, plan.images.get(id));
        } catch { /* best-effort */ }
        imageDone++;
        report();
      }, stop.signal);
    })();

    return () => {
      cancelled = true;
      stop.abort();
      setProgress(null);
    };
  }, [active, plan, onLazyLoadImageRef]);

  if (!progress || !slot) return null;
  return createPortal(
    <NoticePill tone="indigo" spinner>Preloading {progress.done}/{progress.total}</NoticePill>,
    slot,
  );
}
