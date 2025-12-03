import React, { useState, useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import { speak } from '../services/speech';

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

  useEffect(() => {
    if (autoPlay) {
      handlePlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay]);

  const handlePlay = (e?: React.MouseEvent) => {
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
          console.error("Speech synthesis error", event);
          setIsPlaying(false);
        }
      });
    } catch (err) {
      console.error("Speech synthesis failed", err);
      setIsPlaying(false);
    }
  };

  return (
    <button 
      type="button"
      onClick={handlePlay}
      className={`
        inline-flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-sm transition-all duration-150
        ${isPlaying 
          ? 'bg-indigo-600 text-white shadow-md scale-[1.02]' 
          : 'bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 active:scale-95'
        }
        ${className}
      `}
      title="Click to listen"
    >
      {showIcon && (
        <Volume2 
          size={16} 
          strokeWidth={2} 
          className={`shrink-0 ${isPlaying ? 'animate-pulse' : ''}`}
        />
      )}
      <span className="break-words text-left leading-tight">{ipa || text}</span>
    </button>
  );
};

