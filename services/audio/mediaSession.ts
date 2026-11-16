// ---------------------------------------------------------------------------
// Media Session — lock-screen controls + background audio for sentence autoplay
// ---------------------------------------------------------------------------
// Playback already runs through one <audio> element, so wiring the OS Media Session lets the installed
// PWA keep reading sentences with the screen locked and exposes play/pause/next/prev on the lock screen.
// Playback state is mirrored centrally by the player (mirrorPlaybackStatus); metadata + action handlers are
// driven by the autoplay caller (DetailView).
import type { PlaybackStatus } from './player';

const hasMediaSession = (): boolean => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

// What the lock screen shows: the engine's status, unless a caller that knows better has set an override.
let engineStatus: PlaybackStatus = 'idle';
let statusOverride: 'playing' | 'paused' | null = null;

const showPlaybackState = (): void => {
  if (!hasMediaSession()) return;
  try {
    navigator.mediaSession.playbackState = statusOverride
      ?? (engineStatus === 'playing' || engineStatus === 'loading' ? 'playing' : engineStatus === 'paused' ? 'paused' : 'none');
  } catch { /* ignore */ }
};

/** Mirror the playback status to the OS media session so the lock screen reflects play ⇄ pause in the background. */
export const mirrorPlaybackStatus = (status: PlaybackStatus): void => {
  engineStatus = status;
  showPlaybackState();
};

/**
 * Show `status` on the lock screen whatever the engine reports, or with null go back to following it. Auto-play sets
 * 'playing' while it runs, gaps between reads included, and 'paused' while it's paused, so the headset's one
 * play/pause button pauses it in a gap rather than asking to play.
 */
export const setPlaybackStateOverride = (status: 'playing' | 'paused' | null): void => {
  statusOverride = status;
  showPlaybackState();
};

/** Set the lock-screen "now playing" card. Safe no-op where Media Session is unsupported. */
export const setMediaMetadata = (info: { title: string; artist?: string; album?: string; artworkUrl?: string }): void => {
  if (!hasMediaSession()) return;
  try {
    const artwork: MediaImage[] = [];
    if (info.artworkUrl) {
      const m = info.artworkUrl.match(/^data:(image\/[a-z0-9.+-]+)/i);
      artwork.push({ src: info.artworkUrl, sizes: '512x512', type: m ? m[1] : 'image/jpeg' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title || 'DictProp',
      artist: info.artist || 'DictProp',
      album: info.album || '',
      artwork,
    });
  } catch { /* ignore */ }
};

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

/** What the lock screen's play, pause and stop do when the caller doesn't handle them itself. */
export interface DefaultMediaActions {
  play: () => void;
  pause: () => void;
  stop: () => void;
}

/** Register lock-screen action handlers, or pass null to clear them (and the metadata). */
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null, defaults: DefaultMediaActions): void => {
  if (!hasMediaSession()) return;
  const ms = navigator.mediaSession;
  const set = (action: MediaSessionAction, cb?: () => void) => {
    try { ms.setActionHandler(action, cb ? () => cb() : null); } catch { /* action unsupported here */ }
  };
  if (!handlers) {
    (['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as MediaSessionAction[]).forEach((a) => set(a));
    try { ms.metadata = null; } catch { /* ignore */ }
    return;
  }
  set('play', handlers.onPlay ?? defaults.play);
  set('pause', handlers.onPause ?? defaults.pause);
  set('stop', handlers.onStop ?? defaults.stop);
  set('nexttrack', handlers.onNext);
  set('previoustrack', handlers.onPrev);
};
