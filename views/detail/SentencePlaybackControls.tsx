import { AudioLines, Play, X } from 'lucide-react';
import { SpeechStyleToggle } from '../../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../../components/PlaybackSpeedToggle';
import { AutoPlayCountdown } from '../../components/AutoPlayCountdown';
import type { TtsStyle } from '../../services/ttsSettings';

interface SentencePlaybackControlsProps {
  /** Clear or Casual, remembered on the sentence under review. */
  onSpeechStyleChange: (style: TtsStyle) => void;
  autoPlaying: boolean;
  /** Auto-play is paused (something else spoke, or a pause control): its button shows Play, and a tap resumes. */
  paused?: boolean;
  /** Starts auto-play and opens its panel, or toggles the panel while it runs. */
  onAutoPlayButton: () => void;
  /** Resumes paused auto-play. */
  onResume?: () => void;
  showPanel: boolean;
  onClosePanel: () => void;
  /** When the running countdown began, moved on by the time spent paused; null while stopped or paused. */
  countdownStartedAt: number | null;
  /** The time left while paused, standing still. */
  countdownFrozenMs?: number | null;
  timerMinutes: number;
  onCycleTimer: () => void;
  repeats: number;
  onCycleRepeats: () => void;
  /** Milliseconds of silence between reads. */
  gap: number;
  onCycleGap: () => void;
  onStop: () => void;
}

/** What a tap on the auto-play button does: start auto-play (and open its panel), resume it, or open or close its panel. */
export type AutoPlayFabAction = 'start' | 'resume' | 'toggle-panel';

export const autoPlayFabAction = ({ autoPlaying, paused }: { autoPlaying: boolean; paused: boolean }): AutoPlayFabAction =>
  !autoPlaying ? 'start' : paused ? 'resume' : 'toggle-panel';

/**
 * Sentence review's floating playback cluster: the speech style on the primary surface, and the auto-play button,
 * whose panel holds only auto-play's own settings and its Stop. The 44 px cluster sits 4 px above the lesson row's
 * buttons and tops out 8 px below the notices and the search button, and the panel opens high enough that Stop
 * auto-play clears the search button, at any safe-area inset (test/client/card-float-geometry.test.ts).
 */
export function SentencePlaybackControls({
  onSpeechStyleChange, autoPlaying, paused = false, onAutoPlayButton, onResume, showPanel, onClosePanel,
  countdownStartedAt, countdownFrozenMs = null, timerMinutes, onCycleTimer, repeats, onCycleRepeats, gap, onCycleGap,
  onStop,
}: SentencePlaybackControlsProps) {
  const pausedAutoPlay = autoPlaying && paused;
  const onFabClick = () => {
    if (autoPlayFabAction({ autoPlaying, paused }) === 'resume') onResume?.();
    else onAutoPlayButton();
  };
  return (
    <div className="fixed bottom-[max(2.75rem,calc(env(safe-area-inset-bottom)+2.25rem))] right-4 z-[80] flex items-center gap-2">
      <SpeechStyleToggle
        className="shrink-0 bg-white shadow-lg border border-slate-200"
        onChange={onSpeechStyleChange}
      />
      <div className="relative shrink-0">
        {showPanel && (
          <div role="dialog" aria-label="Sentence auto-play settings" className="absolute bottom-[6.75rem] right-0 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">Auto-play</span>
              <button type="button" onClick={onClosePanel} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600" title="Close settings">
                <X size={16} />
              </button>
            </div>
            <div className="mb-3 flex justify-end">
              <PlaybackSpeedToggle className="bg-slate-100" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={onCycleTimer} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Auto-play duration">
                <span className="block text-[10px] font-medium text-slate-400">Duration</span>
                <AutoPlayCountdown
                  deadline={countdownStartedAt === null ? null : countdownStartedAt + timerMinutes * 60_000}
                  frozenRemainingMs={countdownFrozenMs}
                  minutes={timerMinutes}
                />
              </button>
              <button type="button" onClick={onCycleRepeats} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Times each sentence is read">
                <span className="block text-[10px] font-medium text-slate-400">Repeats</span>
                ×{repeats}
              </button>
              <button type="button" onClick={onCycleGap} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Gap between reads">
                <span className="block text-[10px] font-medium text-slate-400">Interval</span>
                {gap / 1000}s
              </button>
            </div>
            <button
              type="button"
              onClick={onStop}
              className="mt-3 w-full rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-100"
            >
              Stop auto-play
            </button>
          </div>
        )}
        <button
          onClick={onFabClick}
          className={`w-11 h-11 rounded-full shadow-lg flex items-center justify-center transition-all ${
            autoPlaying
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={pausedAutoPlay ? 'Resume sentence auto-play' : autoPlaying ? 'Auto-play settings' : 'Start sentence auto-play'}
          aria-label={pausedAutoPlay ? 'Resume sentence auto-play' : autoPlaying ? 'Open sentence auto-play settings' : 'Start sentence auto-play'}
        >
          {pausedAutoPlay ? <Play size={20} className="ml-0.5" /> : <AudioLines size={20} />}
        </button>
      </div>
    </div>
  );
}
