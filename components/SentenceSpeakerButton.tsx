import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { Volume2, Loader2, Pause, Play } from 'lucide-react';
import {
  speakNatural,
  getPlaybackState,
  getPlaybackProgress,
  pauseCurrent,
  resumeCurrent,
  stopCurrent,
  type SpeakHandle,
} from '../services/neuralTts';
import { toggleActionFor } from '../services/audio/playbackToggle';
import { usePlaybackStatus } from '../hooks/audio/usePlaybackStatus';
import { useLatest } from '../hooks/useStableValue';
import { stripSentenceMarkers } from '../services/sentenceMarkers';

interface Props {
  /** The example sentence (may contain {{…}}/[[…]] markers — they're stripped before speaking). */
  text: string;
  className?: string;
  iconSize?: number;
  /** Called only after playback reaches the end successfully, never on pause/cancel/error. */
  onComplete?: () => void;
  /** Takes the click instead of the button's own play, pause, resume or restart (sentence auto-play's pause, say). The icon
   *  still follows the engine's state for the sentence. */
  onToggle?: () => void;
  /** Whether unmounting stops the read this button started, if it still plays. Off for a row that scrolls out of a
   *  list while its sentence goes on. */
  stopOnUnmount?: boolean;
  /** Hears the handle of each read the button starts, so its owner can stop that read later. */
  onPlaybackStart?: (handle: SpeakHandle) => void;
  /** 'dark' draws the icon white, for a dark button the caller styles; 'light' (the default) draws it indigo. */
  tone?: 'light' | 'dark';
}

/**
 * Small icon button that reads an example sentence aloud in the natural voice: the server's cached MiMo
 * clip, or on a miss the in-browser Kokoro voice (the system voice on iOS/iPadOS).
 *
 * It is a PURE SUBSCRIBER to the shared playback state (services/neuralTts), keyed by the sentence
 * text. So the icon always reflects what's actually playing — whether playback was started by THIS
 * button, another speaker, the E / Cmd+1–4 keyboard readers, or swipe-to-speak. Because it holds no
 * private "isPlaying" state, it can't get stuck out of sync (the old "frozen on pause" bug), and a
 * click always does the right thing: pause, resume, restart-near-end, or start fresh, unless the caller takes the
 * click itself (onToggle).
 */
export const SentenceSpeakerButton: React.FC<Props> = ({
  text, className = '', iconSize = 14, onComplete, onToggle, stopOnUnmount = true, onPlaybackStart,
  tone = 'light',
}) => {
  const plain = useMemo(() => stripSentenceMarkers(text || '').trim(), [text]);
  const status = usePlaybackStatus(plain);
  const playbackHandleRef = useRef<SpeakHandle | null>(null);
  const stopOnUnmountRef = useLatest(stopOnUnmount);

  // A matching text value does not prove ownership: another view may already be reading the same
  // sentence. The returned handle is token-scoped, so unmount only stops playback this button began.
  useEffect(() => () => { if (stopOnUnmountRef.current) playbackHandleRef.current?.stop(); }, [stopOnUnmountRef]);

  const isLoading = status === 'loading';
  const isPlaying = status === 'playing' || status === 'paused';
  const isPaused = status === 'paused';
  const label = isLoading ? 'Loading natural voice' : !isPlaying ? 'Listen to this sentence' : isPaused ? 'Resume' : 'Pause';

  const start = useCallback(() => {
    const handle = speakNatural(plain, { allowDownload: true, onEnd: onComplete });
    playbackHandleRef.current = handle;
    onPlaybackStart?.(handle);
  }, [plain, onComplete, onPlaybackStart]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!plain) return;
    if (onToggle) { onToggle(); return; }
    switch (toggleActionFor(getPlaybackState(), plain, getPlaybackProgress(), { onLoading: 'cancel', restartNearEnd: true })) {
      case 'cancel': stopCurrent(); return; // a load that hasn't started playing yet
      case 'resume': resumeCurrent(); return;
      case 'pause': pauseCurrent(); return;
      case 'restart': // almost finished → from the top instead of a pointless near-end pause
      case 'start': start(); return; // idle, or a different sentence is active → ours from the top
      case 'ignore': return;
    }
  }, [plain, start, onToggle]);

  // Callers passing a className size the button themselves. The bare icon gets a bigger tap target (34px
  // at the default size), with negative margins so it takes up no more room in the layout than before.
  const sizing = className ? '' : 'p-2.5 -m-2';
  const color = tone === 'dark' ? 'text-white' : isPlaying ? 'text-indigo-500' : 'text-indigo-300 hover:text-indigo-600';

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`${sizing} transition-colors ${color} ${className}`}
      title={label}
      aria-label={label}
    >
      {isLoading ? (
        <Loader2 size={iconSize} className="animate-spin" />
      ) : isPlaying && !isPaused ? (
        <Pause size={iconSize} className="animate-pulse" />
      ) : isPlaying && isPaused ? (
        <Play size={iconSize} />
      ) : (
        <Volume2 size={iconSize} />
      )}
    </button>
  );
};
