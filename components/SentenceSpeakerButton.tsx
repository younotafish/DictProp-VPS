import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Volume2, Loader2 } from 'lucide-react';
import { speakNatural, type SpeakHandle } from '../services/neuralTts';
import { error as logError } from '../services/logger';

interface Props {
  /** The example sentence (may contain {{…}}/[[…]] markers — they're stripped before speaking). */
  text: string;
  voice?: string;
  className?: string;
}

/**
 * Small icon button that reads an example sentence aloud in the natural neural voice
 * (Kokoro, on-device) — falling back to the system voice on unsupported devices. A
 * deliberate click, so it's allowed to trigger the one-time model download.
 */
export const SentenceSpeakerButton: React.FC<Props> = ({ text, voice, className = '' }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const handleRef = useRef<SpeakHandle | null>(null);

  useEffect(() => {
    return () => { handleRef.current?.stop(); };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPlaying || isLoading) {
      handleRef.current?.stop();
      handleRef.current = null;
      setIsPlaying(false);
      setIsLoading(false);
      return;
    }
    if (!text) return;
    setIsLoading(true);
    try {
      handleRef.current = speakNatural(text, {
        voice,
        allowDownload: true,
        onStart: () => { setIsLoading(false); setIsPlaying(true); },
        onEnd: () => { setIsPlaying(false); setIsLoading(false); },
        onError: (event) => {
          logError('Sentence speech error', event);
          setIsPlaying(false);
          setIsLoading(false);
        },
      });
    } catch (err) {
      logError('Sentence speech failed', err);
      setIsLoading(false);
      setIsPlaying(false);
    }
  }, [text, voice, isPlaying, isLoading]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`p-0.5 transition-colors ${isPlaying ? 'text-indigo-500' : 'text-indigo-300 hover:text-indigo-600'} ${className}`}
      title={isLoading ? 'Loading natural voice…' : isPlaying ? 'Stop' : 'Listen to this sentence'}
    >
      {isLoading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Volume2 size={14} className={isPlaying ? 'animate-pulse' : ''} />
      )}
    </button>
  );
};
