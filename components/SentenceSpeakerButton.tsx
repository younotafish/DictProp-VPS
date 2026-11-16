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
import { stripSentenceMarkers } from '../services/sentenceMarkers';

interface Props {
  /** The example sentence (may contain {{…}}/[[…]] markers — they're stripped before speaking). */
  text: string;
  className?: string;
  iconSize?: number;
  /** Called only after playback reaches the end successfully, never on pause/cancel/error. */
  onComplete?: () => void;
}

/**
 * Small icon button that reads an example sentence aloud in the natural voice: the server's cached MiMo
 * clip, or on a miss the in-browser Kokoro voice (the system voice on iOS/iPadOS).
 *
 * It is a PURE SUBSCRIBER to the shared playback state (services/neuralTts), keyed by the sentence
 * text. So the icon always reflects what's actually playing — whether playback was started by THIS
 * button, another speaker, the E / Cmd+1–4 keyboard readers, or swipe-to-speak. Because it holds no
 * private "isPlaying" state, it can't get stuck out of sync (the old "frozen on pause" bug), and a
 * click always does the right thing: pause, resume, restart-near-end, or start fresh.
 */
export const SentenceSpeakerButton: React.FC<Props> = ({ text, className = '', iconSize = 14, onComplete }) => {
  const plain = useMemo(() => stripSentenceMarkers(text || '').trim(), [text]);
  const status = usePlaybackStatus(plain);
  const playbackHandleRef = useRef<SpeakHandle | null>(null);

  // A matching text value does not prove ownership: another view may already be reading the same
  // sentence. The returned handle is token-scoped, so unmount only stops playback this button began.
  useEffect(() => () => { playbackHandleRef.current?.stop(); }, []);

  const isLoading = status === 'loading';
  const isPlaying = status === 'playing' || status === 'paused';
  const isPaused = status === 'paused';
  const label = isLoading ? 'Loading natural voice' : !isPlaying ? 'Listen to this sentence' : isPaused ? 'Resume' : 'Pause';

  const start = useCallback(() => {
    playbackHandleRef.current = speakNatural(plain, { allowDownload: true, onEnd: onComplete });
  }, [plain, onComplete]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!plain) return;
    switch (toggleActionFor(getPlaybackState(), plain, getPlaybackProgress(), { onLoading: 'cancel', restartNearEnd: true })) {
      case 'cancel': stopCurrent(); return; // a load that hasn't started playing yet
      case 'resume': resumeCurrent(); return;
      case 'pause': pauseCurrent(); return;
      case 'restart': // almost finished → from the top instead of a pointless near-end pause
      case 'start': start(); return; // idle, or a different sentence is active → ours from the top
      case 'ignore': return;
    }
  }, [plain, start]);

  // Callers passing a className size the button themselves. The bare icon gets a bigger tap target (34px
  // at the default size), with negative margins so it takes up no more room in the layout than before.
  const sizing = className ? '' : 'p-2.5 -m-2';

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`${sizing} transition-colors ${isPlaying ? 'text-indigo-500' : 'text-indigo-300 hover:text-indigo-600'} ${className}`}
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
