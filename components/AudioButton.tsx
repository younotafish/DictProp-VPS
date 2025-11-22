
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

  // Reset state if text changes
  useEffect(() => {
    window.speechSynthesis.cancel();
    setIsPlaying(false);
  }, [text]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    props.onClick?.(e);

    if (!text) return;

    if (isPlaying) {
      // Stop if currently playing
      window.speechSynthesis.cancel();
      setIsPlaying(false);
    } else {
      // Always cancel any existing speech before starting new to prevent queueing bugs
      window.speechSynthesis.cancel();
      
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      
      u.onstart = () => setIsPlaying(true);
      u.onend = () => setIsPlaying(false);
      u.onerror = (event) => {
          // 'canceled' or 'interrupted' errors are expected when we manually stop/switch
          if (event.error !== 'canceled' && event.error !== 'interrupted') {
             console.error("Speech synthesis error:", event.error);
          }
          setIsPlaying(false);
      };
      
      utteranceRef.current = u;
      window.speechSynthesis.speak(u);
      
      // Optimistically set playing to true to give immediate UI feedback
      setIsPlaying(true);
    }
  };

  // Use Square (Stop) when playing, otherwise the initial icon (usually Volume or Play)
  const Icon = isPlaying ? Square : InitialIcon;
  
  // Fill the icon if requested and NOT playing (e.g. filled Play button)
  const shouldFill = fillIcon && !isPlaying;

  return (
    <button 
      onClick={handleClick} 
      className={`${className} ${isPlaying ? 'text-indigo-600 animate-pulse' : ''}`} 
      {...props}
    >
       <Icon size={iconSize} fill={shouldFill ? "currentColor" : "none"} />
    </button>
  );
};
