import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { loadImage } from '../services/storage';

interface Props {
  src?: string;
  itemId?: string; // Load image from IDB by item ID (used when images are offloaded from state)
  alt: string;
  className?: string;
  fallbackClassName?: string;
  onMissing?: (itemId: string) => void; // Called when IDB has no image — triggers server fetch
}

/**
 * Image component with offline support
 * - If `src` is a base64 data URI, renders it directly
 * - If `itemId` is provided, lazy-loads base64 from IDB images store
 * - If IDB has no image, calls `onMissing` to trigger server fetch, shows loading state
 */
export const OfflineImage: React.FC<Props> = ({
  src,
  itemId,
  alt,
  className = '',
  fallbackClassName = '',
  onMissing
}) => {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [idbSrc, setIdbSrc] = useState<string | null>(null);
  const [idbLoading, setIdbLoading] = useState(false);
  const [fetchingFromServer, setFetchingFromServer] = useState(false);
  const prevSrcRef = useRef<string | undefined>(src);
  const prevItemIdRef = useRef<string | undefined>(undefined);
  const missingCalledRef = useRef<string | undefined>(undefined);

  // Use layoutEffect to reset BEFORE paint, avoiding flicker
  useLayoutEffect(() => {
    if (prevSrcRef.current !== src) {
      prevSrcRef.current = src;
      setHasError(false);
      setIsLoaded(false);
    }
  }, [src]);

  // Load image from IDB when itemId is provided
  useEffect(() => {
    // Direct base64 src takes priority
    if (src?.startsWith('data:image/')) return;
    if (!itemId) return;
    if (prevItemIdRef.current === itemId && idbSrc !== null) return;
    prevItemIdRef.current = itemId;

    let cancelled = false;
    setIdbLoading(true);
    loadImage(itemId).then(base64 => {
      if (cancelled) return;
      setIdbSrc(base64);
      setIdbLoading(false);
      if (base64) {
        setHasError(false);
        setIsLoaded(false);
      } else if (onMissing && missingCalledRef.current !== itemId) {
        // IDB has no image — ask parent to fetch from server
        missingCalledRef.current = itemId;
        setFetchingFromServer(true);
        onMissing(itemId);
      }
    });
    return () => { cancelled = true; };
  }, [itemId, src, onMissing]);

  // Re-check IDB after onMissing fires (server fetch saves to IDB, then we retry)
  useEffect(() => {
    if (!fetchingFromServer || !itemId) return;

    // Poll IDB briefly — server fetch + IDB write is async
    let cancelled = false;
    const checkInterval = setInterval(async () => {
      const base64 = await loadImage(itemId);
      if (cancelled) return;
      if (base64) {
        setIdbSrc(base64);
        setFetchingFromServer(false);
        setHasError(false);
        setIsLoaded(false);
        clearInterval(checkInterval);
      }
    }, 1000);

    // Give up after 15 seconds
    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      if (!cancelled) setFetchingFromServer(false);
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(checkInterval);
      clearTimeout(timeout);
    };
  }, [fetchingFromServer, itemId]);

  const effectiveSrc = (src?.startsWith('data:image/') ? src : undefined) || idbSrc;

  // Loading from IDB or fetching from server — show skeleton
  if ((idbLoading || fetchingFromServer) && !effectiveSrc) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <Loader2 size={20} className="animate-spin text-slate-300" />
      </div>
    );
  }

  // No image available — show placeholder
  if (!effectiveSrc) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <div className="text-center text-slate-400">
          <ImageOff size={24} className="mx-auto mb-1 opacity-50" />
          <span className="text-[10px] uppercase tracking-wide font-medium">
            No Image
          </span>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <div className="text-center text-slate-400">
          <ImageOff size={24} className="mx-auto mb-1 opacity-50" />
          <span className="text-[10px] uppercase tracking-wide font-medium">
            Error
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
      <img
        src={effectiveSrc}
        alt={alt}
        className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoaded(true)}
      />
    </div>
  );
};
