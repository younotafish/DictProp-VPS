import React, { useState, useEffect, useCallback } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { loadImage, peekImage } from '../services/storage';

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
 * - If `src` is a base64 data URI or authenticated same-origin API URL, renders it directly.
 * - Else if `itemId` is provided, shows the picture straight from the memory cache when it's there, and
 *   otherwise lazy-loads it from the IDB images store, then (on a miss) from the server via `onMissing`.
 *
 * Everything is keyed to the CURRENT image identity (`idKey`): on a fast swipe/scroll to another
 * item the displayed image is reset in the same render, and a miss / failed download shows a placeholder —
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
  const directSrc = src && (src.startsWith('data:image/') || src.startsWith('/api/')) ? src : undefined;
  const serverVersion = src?.startsWith('server:has_image:')
    ? src.slice('server:has_image:'.length)
    : undefined;
  // Identity of the image to show. Changes when we switch items → triggers the reset below.
  const idKey = directSrc ?? (itemId ? `id:${itemId}:${serverVersion || 'local'}` : '');
  // A picture already in memory shows on the first frame instead of after a storage round trip.
  const immediateSrc = () => directSrc ?? (itemId ? peekImage(itemId, serverVersion) ?? undefined : undefined);

  const [shownKey, setShownKey] = useState(idKey);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(immediateSrc);
  const [loading, setLoading] = useState<boolean>(!resolvedSrc && !!itemId);
  const [hasError, setHasError] = useState(false);

  // Reset in the same render when the image identity changes, so a previous item's picture is never
  // shown during the gap before the new one loads (or if it never does).
  if (shownKey !== idKey) {
    const next = immediateSrc();
    setShownKey(idKey);
    setResolvedSrc(next);
    setLoading(!next && !!itemId);
    setHasError(false);
  }

  // Lazy-load by itemId: IDB first, then the server WITH RETRY. `onMissing` returning null means the
  // item genuinely has no image (→ placeholder, stop); `onMissing` THROWING means a transient failure
  // (flaky network) → retry with backoff so the real picture still shows. A late resolution can't land
  // on a newer item (cancellation guard), and we never fall back to the previous item's image.
  useEffect(() => {
    if (directSrc || !itemId) return;
    let cancelled = false;

    const BACKOFFS = [500, 1500, 4000]; // ms before retries 2, 3, 4 (transient failures only)
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    (async () => {
      // 1) Memory or IDB cache — fast, no retry needed. A picture shown from memory resolves to itself.
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
    <Picture
      key={resolvedSrc}
      src={resolvedSrc}
      alt={alt}
      className={className}
      overlayClassName={fallbackClassName}
      onError={() => setHasError(true)}
    />
  );
};

interface PictureProps {
  src: string;
  alt: string;
  className: string;
  overlayClassName: string;
  onError: () => void;
}

/**
 * One picture, remounted per src so no previously decoded frame lingers under a new one. A picture the
 * browser already has is complete as soon as it's attached and paints on the first frame; one that
 * arrives later eases in.
 */
const Picture: React.FC<PictureProps> = ({ src, alt, className, overlayClassName, onError }) => {
  const [shown, setShown] = useState<'pending' | 'ready' | 'fade'>('pending');
  const showIfComplete = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setShown(state => state === 'pending' ? 'ready' : state);
  }, []);

  return (
    <div className="relative w-full h-full">
      {shown === 'pending' && (
        <div className={`bg-slate-100 animate-pulse absolute inset-0 ${overlayClassName}`} />
      )}
      <img
        ref={showIfComplete}
        src={src}
        alt={alt}
        className={shown === 'fade' ? `${className} image-fade-in` : className}
        onError={onError}
        onLoad={() => setShown(state => state === 'pending' ? 'fade' : state)}
      />
    </div>
  );
};
