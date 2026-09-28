import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { preloadAudio } from '../services/lazyTts';
import { getStoredImageIds } from '../services/storage';
import { useLatest } from '../hooks/useStableValue';
import { stripSentenceMarkers } from './HighlightedSentence';

export interface PreloadSession {
  /** The sentences to voice. */
  texts: string[];
  /** The pictures to pull into IndexedDB, by item id, with the server's image version when known. */
  images: Map<string, string | undefined>;
}

interface SessionPreloadProps {
  /** Starts the preload; turning it off cancels what's left. */
  active: boolean;
  /** Reads the session when the preload starts. */
  getSession: () => PreloadSession;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
}

const IMAGE_CONCURRENCY = 4;

/**
 * Once auto-play is requested, preloads the whole session so a poor or unstable network can't interrupt
 * review: every sentence's audio and timings, and every picture the session shows. Best-effort and
 * cancellable; failures still advance the progress, so it always completes. The progress pill keeps its
 * state here, so the card doesn't re-render for every clip and picture that arrives.
 */
export function SessionPreload({ active, getSession, onLazyLoadImage }: SessionPreloadProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const getSessionRef = useLatest(getSession);
  const onLazyLoadImageRef = useLatest(onLazyLoadImage);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const { texts, images } = getSessionRef.current();
    const loadImage = onLazyLoadImageRef.current;
    const ids = [...images.keys()];

    const audioTotal = new Set(texts.map(text => stripSentenceMarkers(text || '').trim()).filter(Boolean)).size;
    const total = audioTotal + (loadImage ? ids.length : 0);
    if (total === 0) return;

    let audioDone = 0;
    let imageDone = 0;
    const report = () => {
      if (cancelled) return;
      const done = audioDone + imageDone;
      setProgress(done >= total ? null : { done, total });
    };
    report();

    // Audio: one progress-reporting batch, which dedupes and generates what's missing itself.
    preloadAudio(texts, done => { audioDone = done; report(); }).catch(() => {});

    // Pictures already in IndexedDB only need an existence check (opening each would churn the memory
    // cache); the rest download a few at a time.
    (async () => {
      if (!loadImage || ids.length === 0) return;
      const expected = new Map<string, string>();
      for (const [id, version] of images) if (version) expected.set(id, version);
      const stored = await getStoredImageIds(ids, expected);
      if (cancelled) return;
      const missing = ids.filter(id => !stored.has(id));
      imageDone = ids.length - missing.length;
      report();
      let next = 0;
      const worker = async () => {
        while (next < missing.length && !cancelled) {
          const id = missing[next++];
          try {
            await loadImage(id, images.get(id));
          } catch { /* best-effort */ }
          imageDone++;
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, missing.length) }, worker));
    })();

    return () => {
      cancelled = true;
      setProgress(null);
    };
  }, [active, getSessionRef, onLazyLoadImageRef]);

  if (!progress) return null;
  return (
    <div className="fixed bottom-6 left-6 z-[60] flex items-center gap-2 bg-white text-slate-600 text-xs font-medium px-3 py-2 rounded-full shadow-lg border border-slate-200 fade-in">
      <Loader2 size={14} className="animate-spin text-indigo-500" />
      <span>Preloading {progress.done}/{progress.total}</span>
    </div>
  );
}
