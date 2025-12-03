import React, { useState } from 'react';
import { ImageOff } from 'lucide-react';

interface Props {
  src: string;
  alt: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * Image component with offline support
 * - Base64 images work offline (stored with data in Firestore)
 * - URL images may fail offline (shows fallback)
 */
export const OfflineImage: React.FC<Props> = ({ 
  src, 
  alt, 
  className = '', 
  fallbackClassName = ''
}) => {
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  // Base64 images always work offline
  const isBase64 = src?.startsWith('data:image/');

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
    <>
      {isLoading && (
        <div className={`flex items-center justify-center bg-slate-100 animate-pulse absolute inset-0 ${fallbackClassName}`} />
      )}
      <img 
        src={src} 
        alt={alt} 
        className={`${className} ${isLoading ? 'opacity-0' : 'opacity-100'} transition-opacity`}
        onError={() => setHasError(true)}
        onLoad={() => setIsLoading(false)}
      />
    </>
  );
};

