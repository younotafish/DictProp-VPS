import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { ImageOff } from 'lucide-react';
import { loadImage } from '../services/storage';

interface Props {
  src?: string;
  itemId?: string; // Load image from IDB by item ID (used when images are offloaded from state)
  alt: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * Image component with offline support
 * - If `src` is provided, renders it directly (backwards compatible)
 * - If `itemId` is provided (and no src), lazy-loads base64 from IDB images store
 * - Shows skeleton while loading from IDB
 */
export const OfflineImage: React.FC<Props> = ({
  src,
  itemId,
  alt,
  className = '',
  fallbackClassName = ''
}) => {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [idbSrc, setIdbSrc] = useState<string | null>(null);
  const [idbLoading, setIdbLoading] = useState(false);
  const prevSrcRef = useRef<string | undefined>(src);
  const prevItemIdRef = useRef<string | undefined>(itemId);

  // Use layoutEffect to reset BEFORE paint, avoiding flicker
  // Only reset when src actually changes to a DIFFERENT value
  useLayoutEffect(() => {
    if (prevSrcRef.current !== src) {
      prevSrcRef.current = src;
      setHasError(false);
      setIsLoaded(false);
    }
  }, [src]);

  // Load image from IDB when itemId is provided and no direct src
  useEffect(() => {
    if (src) return; // Direct src takes priority
    if (!itemId) return;
    if (prevItemIdRef.current === itemId && idbSrc !== null) return; // Already loaded for this ID
    prevItemIdRef.current = itemId;

    let cancelled = false;
    setIdbLoading(true);
    loadImage(itemId).then(base64 => {
      if (!cancelled) {
        setIdbSrc(base64);
        setIdbLoading(false);
        if (base64) {
          setHasError(false);
          setIsLoaded(false);
        }
      }
    });
    return () => { cancelled = true; };
  }, [itemId, src]);

  const effectiveSrc = src || idbSrc;

  // No src and no itemId, or IDB returned nothing — show placeholder
  if (!effectiveSrc && !idbLoading) {
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

  // Loading from IDB — show skeleton
  if (idbLoading && !effectiveSrc) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 animate-pulse ${fallbackClassName || className}`} />
    );
  }

  // Base64 images always work offline
  const isBase64 = effectiveSrc?.startsWith('data:image/');

  if (hasError) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 ${fallbackClassName || className}`}>
        <div className="text-center text-slate-400">
          <ImageOff size={24} className="mx-auto mb-1 opacity-50" />
          <span className="text-[10px] uppercase tracking-wide font-medium">
            {isBase64 ? 'Error' : 'Offline'}
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
        src={effectiveSrc!}
        alt={alt}
        className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoaded(true)}
      />
    </div>
  );
};
