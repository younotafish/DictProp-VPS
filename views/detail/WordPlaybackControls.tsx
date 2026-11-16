import { AudioLines, Pause, Play } from 'lucide-react';
import { SpeechStyleToggle } from '../../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../../components/PlaybackSpeedToggle';
import { AutoPlayCountdown } from '../../components/AutoPlayCountdown';

interface WordPlaybackControlsProps {
  countdownStartedAt: number | null;
  timerMinutes: number;
  onCycleTimer: () => void;
  /** The word slideshow (Space) is running. */
  slideshowPlaying: boolean;
  /** Milliseconds each slide shows. */
  slideSpeed: number;
  onCycleSpeed: () => void;
  onToggleSlideshow: () => void;
  /** Example auto-play, reading each card's example sentences, is running. */
  examplesPlaying: boolean;
  repeats: number;
  onCycleRepeats: () => void;
  /** Milliseconds of silence between reads. */
  gap: number;
  onCycleGap: () => void;
  onToggleExamples: () => void;
}

/** The word card's floating playback cluster: voice settings, the auto-play timer, and the two auto-play modes with their settings. */
export function WordPlaybackControls({
  countdownStartedAt, timerMinutes, onCycleTimer, slideshowPlaying, slideSpeed, onCycleSpeed, onToggleSlideshow,
  examplesPlaying, repeats, onCycleRepeats, gap, onCycleGap, onToggleExamples,
}: WordPlaybackControlsProps) {
  return (
    <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-6 z-[60] flex items-center gap-2">
      {/* Clear ⇄ Casual speech style (global) — sits with the playback controls. */}
      <SpeechStyleToggle className="bg-white shadow-lg border border-slate-200" />
      {/* Voice speed (global): default 1×, up to 2×. Distinct from the "Speed per slide" pill below. */}
      <PlaybackSpeedToggle className="bg-white shadow-lg border border-slate-200" />
      <button
        onClick={onCycleTimer}
        className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
        title="Auto-play duration"
      >
        <AutoPlayCountdown startedAt={countdownStartedAt} minutes={timerMinutes} />
      </button>
      {slideshowPlaying && (
        <button
          onClick={onCycleSpeed}
          className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          title="Speed per slide"
        >
          {slideSpeed / 1000}s
        </button>
      )}
      {examplesPlaying && (
        <button
          onClick={onCycleRepeats}
          className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          title="Times each sentence is read"
        >
          ×{repeats}
        </button>
      )}
      {examplesPlaying && (
        <button
          onClick={onCycleGap}
          className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          title="Gap between reads"
        >
          {gap / 1000}s gap
        </button>
      )}
      <button
        onClick={onToggleExamples}
        className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
          examplesPlaying
            ? 'bg-emerald-500 text-white hover:bg-emerald-600'
            : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
        }`}
        title={examplesPlaying ? 'Stop auto-play (Space)' : 'Auto-play first sentence of each card'}
      >
        {examplesPlaying ? <Pause size={20} /> : <AudioLines size={20} />}
      </button>
      <button
        onClick={onToggleSlideshow}
        className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
          slideshowPlaying
            ? 'bg-violet-500 text-white hover:bg-violet-600'
            : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
        }`}
        title={slideshowPlaying ? 'Pause (Space)' : 'Auto-play (Space)'}
      >
        {slideshowPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
      </button>
    </div>
  );
}
