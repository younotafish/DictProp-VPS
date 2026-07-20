import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { loadImage } from '../services/storage';

interface Props {
  src?: string;
  itemId?: string; // Load image from IDB by item ID (used when images are offloaded from state)
  alt: string;
  className?: string;
  fallbackClassName?: string;
  onMissing?: (itemId: string, imageVersion?: string) => Promise<string | null>; // Fetch image from server, returns base64
}

/**
 * Image component with offline support.
 * - If `src` is a base64 data URI, renders it directly.
 * - Else if `itemId` is provided, lazy-loads base64 from the IDB images store, then (on a miss)
 *   from the server via `onMissing`.
 *
 * Everything is keyed to the CURRENT image identity (`idKey`): on a fast swipe/scroll to another
 * item the displayed image is reset before paint, and a miss / failed download shows a placeholder —
 * so the previous item's picture is NEVER left on screen (the stale-image bug). A cancellation guard
 * stops a late resolution from a prior item landing on the current one.
 */
export const OfflineImage: React.FC<Props> = ({
  src,
  itemId,
  alt,
  className = '',
  fallbackClassName = '',
  onMissing,
}) => {
  const directSrc = src?.startsWith('data:image/') ? src : undefined;
  const serverVersion = src?.startsWith('server:has_image:')
    ? src.slice('server:has_image:'.length)
    : undefined;
  // Identity of the image to show. Changes when we switch items → triggers the reset below.
  const idKey = directSrc ?? (itemId ? `id:${itemId}:${serverVersion || 'local'}` : '');

  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(directSrc);
  const [loading, setLoading] = useState<boolean>(!directSrc && !!itemId);
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Reset BEFORE paint when the image identity changes, so a previous item's picture is never shown
  // during the gap before the new one loads (or if it never does).
  const prevIdKey = useRef(idKey);
  useLayoutEffect(() => {
    if (prevIdKey.current === idKey) return;
    prevIdKey.current = idKey;
    setResolvedSrc(directSrc);            // direct base64 → show now; lazy (itemId) → undefined → skeleton
    setLoading(!directSrc && !!itemId);
    setHasError(false);
    setIsLoaded(false);
  }, [idKey, directSrc, itemId]);

  // Lazy-load by itemId: IDB first, then the server WITH RETRY. `onMissing` returning null means the
  // item genuinely has no image (→ placeholder, stop); `onMissing` THROWING means a transient failure
  // (flaky network) → retry with backoff so the real picture still shows. A late resolution can't land
  // on a newer item (cancellation guard), and we never fall back to the previous item's image.
  useEffect(() => {
    if (directSrc || !itemId) return;
    let cancelled = false;
    setLoading(true);

    const BACKOFFS = [500, 1500, 4000]; // ms before retries 2, 3, 4 (transient failures only)
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    (async () => {
      // 1) IDB cache — fast, no retry needed.
      try {
        const cached = await loadImage(itemId, serverVersion);
        if (cancelled) return;
        if (cached) { setResolvedSrc(cached); setLoading(false); return; }
      } catch { /* IDB miss/error → fall through to the server */ }

      if (!onMissing) { if (!cancelled) { setResolvedSrc(undefined); setLoading(false); } return; }

      // 2) Server fetch, retrying transient failures; a genuine "no image" (null) stops immediately.
      for (let attempt = 0; ; attempt++) {
        try {
          const img = await onMissing(itemId, serverVersion);
          if (cancelled) return;
          setResolvedSrc(img || undefined); // null = no image → placeholder
          setLoading(false);
          return;
        } catch {
          if (cancelled) return;
          if (attempt >= BACKOFFS.length) { setResolvedSrc(undefined); setLoading(false); return; } // gave up → placeholder (revisit retries)
          await delay(BACKOFFS[attempt]);
          if (cancelled) return;
        }
      }
    })();

    return () => { cancelled = true; };
  }, [idKey, itemId, directSrc, onMissing, serverVersion]);

  // Loading and nothing to show yet — skeleton spinner.
  if (loading && !resolvedSrc) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <Loader2 size={20} className="animate-spin text-slate-300" />
      </div>
    );
  }

  // No image available (missing, failed download, or decode error) — placeholder, NOT a stale image.
  if (!resolvedSrc || hasError) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <div className="text-center text-slate-400">
          <ImageOff size={24} className="mx-auto mb-1 opacity-50" />
          <span className="text-[10px] uppercase tracking-wide font-medium">
            {hasError ? 'Error' : 'No Image'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {!isLoaded && (
        <div className={`flex items-center justify-center bg-slate-100 animate-pulse absolute inset-0 ${fallbackClassName}`} />
      )}
      {/* key forces a fresh element per image so no previously-decoded frame lingers under a new src. */}
      <img
        key={resolvedSrc}
        src={resolvedSrc}
        alt={alt}
        className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoaded(true)}
      />
    </div>
  );
};
