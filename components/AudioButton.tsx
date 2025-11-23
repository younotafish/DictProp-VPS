
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
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Initialize voices (required for iOS Safari)
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        setVoicesLoaded(true);
      }
    };

    // Load voices immediately
    loadVoices();

    // Also listen for voiceschanged event (fires on some browsers)
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

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

    if (!text) {
      console.warn('AudioButton: No text provided for speech synthesis');
      return;
    }

    // Check if speech synthesis is supported
    if (!window.speechSynthesis) {
      console.error('Speech synthesis not supported in this browser');
      alert('Speech synthesis is not supported in your browser');
      return;
    }

    if (isPlaying) {
      // Stop if currently playing
      window.speechSynthesis.cancel();
      setIsPlaying(false);
    } else {
      // Always cancel any existing speech before starting new to prevent queueing bugs
      window.speechSynthesis.cancel();
      
      // Small delay to ensure cancellation completes (iOS Safari fix)
      setTimeout(() => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        u.rate = 0.9;
        u.volume = 1.0;
        u.pitch = 1.0;
        
        // Try to select a specific voice (helps with iOS)
        const voices = window.speechSynthesis.getVoices();
        const englishVoice = voices.find(voice => 
          voice.lang.startsWith('en-') && !voice.name.includes('Google')
        );
        if (englishVoice) {
          u.voice = englishVoice;
        }
        
        u.onstart = () => {
          console.log('Speech started:', text);
          setIsPlaying(true);
        };
        
        u.onend = () => {
          console.log('Speech ended');
          setIsPlaying(false);
        };
        
        u.onerror = (event) => {
          console.error('Speech synthesis error:', event.error, event);
          // 'canceled' or 'interrupted' errors are expected when we manually stop/switch
          if (event.error !== 'canceled' && event.error !== 'interrupted') {
            alert(`Speech error: ${event.error}. Try again.`);
          }
          setIsPlaying(false);
        };
        
        utteranceRef.current = u;
        
        try {
          window.speechSynthesis.speak(u);
          console.log('Speech speak() called for:', text);
          // Optimistically set playing to true to give immediate UI feedback
          setIsPlaying(true);
        } catch (error) {
          console.error('Error calling speak():', error);
          alert('Failed to start speech. Please try again.');
          setIsPlaying(false);
        }
      }, 100);
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
