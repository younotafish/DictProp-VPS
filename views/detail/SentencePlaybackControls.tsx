import { AudioLines, X } from 'lucide-react';
import { SpeechStyleToggle } from '../../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../../components/PlaybackSpeedToggle';
import { AutoPlayCountdown } from '../../components/AutoPlayCountdown';
import type { TtsStyle } from '../../services/ttsSettings';

interface SentencePlaybackControlsProps {
  /** Clear or Casual, remembered on the sentence under review. */
  onSpeechStyleChange: (style: TtsStyle) => void;
  autoPlaying: boolean;
  /** Starts auto-play and opens its panel, or toggles the panel while it runs. */
  onAutoPlayButton: () => void;
  showPanel: boolean;
  onClosePanel: () => void;
  countdownStartedAt: number | null;
  timerMinutes: number;
  onCycleTimer: () => void;
  repeats: number;
  onCycleRepeats: () => void;
  /** Milliseconds of silence between reads. */
  gap: number;
  onCycleGap: () => void;
  onStop: () => void;
}

/**
 * Sentence review's floating playback cluster: the speech style on the primary surface, and the auto-play button,
 * whose panel holds only auto-play's own settings and its Stop.
 */
export function SentencePlaybackControls({
  onSpeechStyleChange, autoPlaying, onAutoPlayButton, showPanel, onClosePanel, countdownStartedAt, timerMinutes,
  onCycleTimer, repeats, onCycleRepeats, gap, onCycleGap, onStop,
}: SentencePlaybackControlsProps) {
  return (
    <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-4 z-[80] flex items-center gap-2">
      <SpeechStyleToggle
        className="shrink-0 bg-white shadow-lg border border-slate-200"
        onChange={onSpeechStyleChange}
      />
      <div className="relative shrink-0">
        {showPanel && (
          <div role="dialog" aria-label="Sentence auto-play settings" className="absolute bottom-14 right-0 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
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
                <AutoPlayCountdown startedAt={countdownStartedAt} minutes={timerMinutes} />
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
          onClick={onAutoPlayButton}
          className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
            autoPlaying
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={autoPlaying ? 'Auto-play settings' : 'Start sentence auto-play'}
          aria-label={autoPlaying ? 'Open sentence auto-play settings' : 'Start sentence auto-play'}
        >
          <AudioLines size={20} />
        </button>
      </div>
    </div>
  );
}
