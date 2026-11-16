// The play/pause decision every speaker control makes for one sentence. Pure, and free of runtime imports, so
// controls can use it without loading the engine.
import type { PlaybackState, PlaybackStatus } from './player';

/** A tap on the playing sentence once this much of it has played starts it again rather than pausing the last bit. */
export const RESTART_NEAR_END = 0.85;

/**
 * What a tap on a control for `text` should do:
 * - start: play it from the top (nothing is active, or another sentence is);
 * - restart: play it again from the top (it's nearly over);
 * - pause / resume: it's playing / paused;
 * - cancel: stop the load that hasn't started playing yet;
 * - ignore: leave the load alone.
 */
export type ToggleAction = 'start' | 'restart' | 'pause' | 'resume' | 'cancel' | 'ignore';

export interface ToggleOptions {
  /** A tap while `text` is still loading: stop the load, or let it carry on. */
  onLoading: 'cancel' | 'ignore';
  /** Play `text` again once RESTART_NEAR_END of it has played, instead of pausing. */
  restartNearEnd: boolean;
}

/** The status the engine reports for `text`: its own while it's the active sentence, idle otherwise. */
export const playbackStatusFor = (state: PlaybackState, text: string): PlaybackStatus =>
  state.text === text ? state.status : 'idle';

/** The decision for a tap on `text`, given the engine's state and the active clip's progress (0..1). */
export const toggleActionFor = (state: PlaybackState, text: string, progress: number, options: ToggleOptions): ToggleAction => {
  switch (playbackStatusFor(state, text)) {
    case 'loading': return options.onLoading;
    case 'paused': return 'resume';
    case 'playing': return options.restartNearEnd && progress >= RESTART_NEAR_END ? 'restart' : 'pause';
    case 'idle': return 'start';
  }
};

/**
 * What tapping Clear or Casual does to the sentence it found playing or loading: read it again from its start in the
 * new voice ('replay'); a paused or idle one stays as it is ('none'), so nothing starts by itself.
 */
export const styleChangeReplay = (status: PlaybackStatus): 'replay' | 'none' =>
  status === 'playing' || status === 'loading' ? 'replay' : 'none';

export type SentenceSpaceAction = 'toggle-autoplay-pause' | 'pause' | 'resume' | 'ignore' | 'start-autoplay';

/**
 * Space in sentence review: while auto-play runs, paused or not, it pauses or resumes auto-play; otherwise it pauses or
 * resumes what's playing, waits for a sentence still loading, or with nothing playing starts auto-play.
 */
export const sentenceSpaceAction = ({ autoPlay, status }: { autoPlay: 'off' | 'running' | 'paused'; status: PlaybackStatus }): SentenceSpaceAction => {
  if (autoPlay !== 'off') return 'toggle-autoplay-pause';
  switch (status) {
    case 'playing': return 'pause';
    case 'paused': return 'resume';
    case 'loading': return 'ignore';
    case 'idle': return 'start-autoplay';
  }
};

export type WordCardSpaceAction = 'stop-examples' | 'pause' | 'resume' | 'ignore' | 'toggle-slideshow';

/**
 * Space on a word card: during example auto-play it stops it, as the auto-play button does; otherwise it pauses or
 * resumes the sentence playing, waits for one still loading, or starts or stops the slideshow.
 */
export const wordCardSpaceAction = ({ examplesRunning, status }: { examplesRunning: boolean; status: PlaybackStatus }): WordCardSpaceAction => {
  if (examplesRunning) return 'stop-examples';
  switch (status) {
    case 'playing': return 'pause';
    case 'paused': return 'resume';
    case 'loading': return 'ignore';
    case 'idle': return 'toggle-slideshow';
  }
};
