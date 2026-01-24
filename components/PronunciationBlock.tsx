import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2 } from 'lucide-react';
import { speak } from '../services/speech';
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
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Initialize voices
  useEffect(() => {
    const loadVoices = () => {
      window.speechSynthesis.getVoices();
    };
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
    };
  }, []);

  const handlePlay = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    if (!text) return;

    // If currently playing, stop it
    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      return;
    }

    try {
      utteranceRef.current = speak(text, {
        onStart: () => setIsPlaying(true),
        onEnd: () => setIsPlaying(false),
        onError: (event) => {
          logError("Speech synthesis error", event);
          setIsPlaying(false);
        }
      });
    } catch (err) {
      logError("Speech synthesis failed", err);
      setIsPlaying(false);
    }
  }, [text, isPlaying]);

  // Auto-play effect
  useEffect(() => {
    if (autoPlay && text) {
      handlePlay();
    }
  }, [autoPlay, text, handlePlay]);

  return (
    <button 
      type="button"
      onClick={handlePlay}
      className={`
        inline-flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-sm transition-all duration-150 border
        ${isPlaying 
          ? 'bg-indigo-600 text-white shadow-lg scale-[1.02] border-indigo-600' 
          : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 active:scale-95 shadow-sm'
        }
        ${className}
      `}
      title="Click to listen"
    >
      {showIcon && (
        <Volume2 
          size={16} 
          strokeWidth={2.5} 
          className={`shrink-0 ${isPlaying ? 'animate-pulse' : 'text-indigo-500'}`}
        />
      )}
      <span className="break-words text-left leading-tight font-semibold">{ipa || text}</span>
    </button>
  );
};
