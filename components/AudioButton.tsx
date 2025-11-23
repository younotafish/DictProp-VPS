import React, { useState, useEffect, useRef } from 'react';
import { Volume2, Square, Play } from 'lucide-react';

interface AudioButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text: string;
  iconSize?: number;
  initialIcon?: React.ElementType;
  fillIcon?: boolean;
}

export const AudioButton: React.FC<AudioButtonProps> = ({ 
  text, 
  className = '', 
  iconSize = 24,
  initialIcon: InitialIcon = Volume2,
  fillIcon = false,
  ...props
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

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    props.onClick?.(e);

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
    u.rate = 0.9; // Slightly slower for clarity
    u.volume = 1.0;

    // Robust Voice Selection Strategy
    const voices = window.speechSynthesis.getVoices();
    
    // Priority List:
    // 1. "Samantha" (High quality iOS/Mac)
    // 2. "Google US English" (High quality Android/Chrome)
    // 3. "Microsoft Zira" (High quality Windows)
    // 4. Any "en-US" voice that is likely a system voice (not Google network if possible, to avoid lag, but Google US English is usually fine)
    // 5. Any English voice
    
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

    utteranceRef.current = u; // Keep reference to prevent garbage collection

    // Direct speak call (CRITICAL for iOS Safari - do not wrap in setTimeout)
    try {
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.error("Speech synthesis failed", err);
      setIsPlaying(false);
    }
  };

  const Icon = isPlaying ? Square : InitialIcon;
  const shouldFill = fillIcon && !isPlaying;

  return (
    <button 
      type="button"
      onClick={handleClick} 
      className={`${className} ${isPlaying ? 'text-indigo-600 animate-pulse' : ''} touch-manipulation cursor-pointer z-20`} 
      title="Play pronunciation"
      aria-label={`Play pronunciation for ${text}`}
      {...props}
    >
       <Icon size={iconSize} fill={shouldFill ? "currentColor" : "none"} />
    </button>
  );
};
