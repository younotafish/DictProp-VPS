import { useSyncExternalStore } from 'react';
import { getPlaybackState, subscribePlayback, type PlaybackStatus } from '../../services/neuralTts';
import { playbackStatusFor } from '../../services/audio/playbackToggle';

const subscribe = (onChange: () => void) => subscribePlayback(() => onChange());

/**
 * The engine's playback status for `text` (a stripped sentence): its own status while it's the active
 * sentence, idle otherwise. A component re-renders only when that status changes, not on every change to
 * whatever else is playing.
 */
export const usePlaybackStatus = (text: string): PlaybackStatus => {
  const snapshot = () => playbackStatusFor(getPlaybackState(), text);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};
