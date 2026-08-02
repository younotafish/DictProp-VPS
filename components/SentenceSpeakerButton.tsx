import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Volume2, Loader2, Pause, Play } from 'lucide-react';
import {
  speakNatural,
  getPlaybackState,
  getPlaybackProgress,
  subscribePlayback,
  pauseCurrent,
  resumeCurrent,
  stopCurrent,
  type SpeakHandle,
  type PlaybackState,
} from '../services/lazyTts';
import { stripSentenceMarkers } from './HighlightedSentence';
import { error as logError } from '../services/logger';

// A second tap once the clip is this far in restarts from the top instead of pausing the last sliver.
const RESTART_NEAR_END = 0.85;

interface Props {
  /** The example sentence (may contain {{…}}/[[…]] markers — they're stripped before speaking). */
  text: string;
  className?: string;
  iconSize?: number;
}

/**
 * Small icon button that reads an example sentence aloud in the natural neural voice
 * (Kokoro/MiMo, on-device) — falling back to the system voice on unsupported devices.
 *
 * It is a PURE SUBSCRIBER to the shared playback state (services/lazyTts), keyed by the sentence
 * text. So the icon always reflects what's actually playing — whether playback was started by THIS
 * button, another speaker, the E / Cmd+1–4 keyboard readers, or swipe-to-speak. Because it holds no
 * private "isPlaying" state, it can't get stuck out of sync (the old "frozen on pause" bug), and a
 * click always does the right thing: pause, resume, restart-near-end, or start fresh.
 */
export const SentenceSpeakerButton: React.FC<Props> = ({ text, className = '', iconSize = 14 }) => {
  const plain = useMemo(() => stripSentenceMarkers(text || '').trim(), [text]);
  const [pb, setPb] = useState<PlaybackState>(getPlaybackState);
  const playbackHandleRef = useRef<SpeakHandle | null>(null);
  useEffect(() => subscribePlayback(setPb), []);

  // A matching text value does not prove ownership: another view may already be reading the same
  // sentence. The returned handle is token-scoped, so unmount only stops playback this button began.
  useEffect(() => () => { playbackHandleRef.current?.stop(); }, []);

  const isMine = !!plain && pb.text === plain;
  const isLoading = isMine && pb.status === 'loading';
  const isPlaying = isMine && (pb.status === 'playing' || pb.status === 'paused');
  const isPaused = isMine && pb.status === 'paused';
  const label = isLoading ? 'Loading natural voice' : !isPlaying ? 'Listen to this sentence' : isPaused ? 'Resume' : 'Pause';

  const start = useCallback(() => {
    try {
      playbackHandleRef.current = speakNatural(plain, { allowDownload: true });
    } catch (err) {
      logError('Sentence speech failed', err);
    }
  }, [plain]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!plain) return;
    const cur = getPlaybackState();
    if (cur.text === plain) {
      if (cur.status === 'loading') { stopCurrent(); return; }   // cancel a load that hasn't started yet
      if (cur.status === 'paused')  { resumeCurrent(); return; }
      if (cur.status === 'playing') {
        // Almost finished → restart from the top instead of a pointless near-end pause.
        if (getPlaybackProgress() >= RESTART_NEAR_END) { start(); return; }
        pauseCurrent();
        return;
      }
    }
    start(); // idle, or a different sentence is active → (re)start ours from the top
  }, [plain, start]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`p-0.5 transition-colors ${isPlaying ? 'text-indigo-500' : 'text-indigo-300 hover:text-indigo-600'} ${className}`}
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
