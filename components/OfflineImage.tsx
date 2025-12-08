import React, { useState, useRef, useLayoutEffect } from 'react';
import { ImageOff } from 'lucide-react';

interface Props {
  src: string | undefined;
  alt: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * Image component with offline support
 * - Base64 images work offline (stored with data in IndexedDB)
 * - URL images may fail offline (shows fallback)
 */
export const OfflineImage: React.FC<Props> = ({ 
  src, 
  alt, 
  className = '', 
  fallbackClassName = ''
}) => {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const prevSrcRef = useRef<string | undefined>(src);
  
  // Use layoutEffect to reset BEFORE paint, avoiding flicker
  // Only reset when src actually changes to a DIFFERENT value
  useLayoutEffect(() => {
    if (prevSrcRef.current !== src) {
      prevSrcRef.current = src;
      setHasError(false);
      setIsLoaded(false);
    }
  }, [src]);
  
  // No src provided - show placeholder
  if (!src) {
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
  
  // Base64 images always work offline
  const isBase64 = src.startsWith('data:image/');

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
        src={src} 
        alt={alt} 
        className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoaded(true)}
      />
    </div>
  );
};
