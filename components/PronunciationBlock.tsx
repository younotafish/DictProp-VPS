import React, { useState, useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';

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

    // If currently playing this text, stop it
    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      return;
    }

    // Stop any other speech
    window.speechSynthesis.cancel();

    // Create utterance
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9; 
    u.volume = 1.0;

    const voices = window.speechSynthesis.getVoices();
    
    let preferredVoice = voices.find(v => v.name === 'Samantha');
    if (!preferredVoice) preferredVoice = voices.find(v => v.name === 'Google US English');
    if (!preferredVoice) preferredVoice = voices.find(v => v.name.includes('Zira'));
    if (!preferredVoice) preferredVoice = voices.find(v => v.lang === 'en-US' && !v.name.includes('Google')); 
    if (!preferredVoice) preferredVoice = voices.find(v => v.lang.startsWith('en'));

    if (preferredVoice) {
      u.voice = preferredVoice;
    }

    u.onstart = () => {
      setIsPlaying(true);
    };

    u.onend = () => {
      setIsPlaying(false);
    };

    u.onerror = (event) => {
      console.error("Speech synthesis error", event);
      setIsPlaying(false);
    };

    utteranceRef.current = u; 

    try {
      window.speechSynthesis.speak(u);
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
        inline-flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-sm transition-all duration-200
        ${isPlaying 
          ? 'bg-indigo-100 text-indigo-700 shadow-sm scale-105 ring-2 ring-indigo-200' 
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800'
        }
        ${className}
      `}
      title="Click to listen"
    >
      {showIcon && <Volume2 size={16} className={`shrink-0 ${isPlaying ? 'animate-pulse text-indigo-600' : ''}`} />}
      <span className="break-words text-left leading-tight">{ipa || text}</span>
    </button>
  );
};

