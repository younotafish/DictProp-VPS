import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, Loader2 } from 'lucide-react';
import { speakNatural, type SpeakHandle } from '../services/neuralTts';
import { error as logError } from '../services/logger';

interface PronunciationBlockProps {
  text: string; // Text to speak
  ipa?: string; // IPA or display text
  className?: string;
  autoPlay?: boolean;
  showIcon?: boolean;
}

export const PronunciationBlock: React.FC<PronunciationBlockProps> = ({
  text,
  ipa,
  className = '',
  autoPlay = false,
  showIcon = true // Always show icon by default to indicate clickable audio
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // first-click model download / synthesis
  const handleRef = useRef<SpeakHandle | null>(null);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  // allowDownload=true for deliberate clicks; false for autoPlay (never auto-pull the model).
  const start = useCallback((allowDownload: boolean) => {
    if (!text) return;
    setIsLoading(true);
    setIsPlaying(false);
    try {
      handleRef.current = speakNatural(text, {
        allowDownload,
        onStart: () => { setIsLoading(false); setIsPlaying(true); },
        onEnd: () => { setIsPlaying(false); setIsLoading(false); },
        onError: (event) => {
          logError('Speech synthesis error', event);
          setIsPlaying(false);
          setIsLoading(false);
        },
      });
    } catch (err) {
      logError('Speech synthesis failed', err);
      setIsLoading(false);
      setIsPlaying(false);
    }
  }, [text]);

  const handleClick = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (isPlaying || isLoading) { stop(); return; }
    start(true);
  }, [isPlaying, isLoading, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { handleRef.current?.stop(); };
  }, []);

  // Auto-play — uses the natural voice only if the model is already loaded, never downloads.
  useEffect(() => {
    if (autoPlay && text) start(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, text]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`
        inline-flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-sm transition-all duration-150 border
        ${isPlaying
          ? 'bg-indigo-600 text-white shadow-lg scale-[1.02] border-indigo-600'
          : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 active:scale-95 shadow-sm'
        }
        ${className}
      `}
      title={isLoading ? 'Loading natural voice…' : 'Click to listen'}
    >
      {showIcon && (
        isLoading ? (
          <Loader2 size={16} strokeWidth={2.5} className="shrink-0 animate-spin text-indigo-500" />
        ) : (
          <Volume2
            size={16}
            strokeWidth={2.5}
            className={`shrink-0 ${isPlaying ? 'animate-pulse' : 'text-indigo-500'}`}
          />
        )
      )}
      <span className="break-words text-left leading-tight font-semibold">{ipa || text}</span>
    </button>
  );
};
