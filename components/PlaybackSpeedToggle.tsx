import React, { useEffect, useState } from 'react';
import { getPlaybackRate, setPlaybackRate, subscribePlaybackRate, RATE_PRESETS } from '../services/neuralTts';

/**
 * Global voice-speed control for example-sentence playback. The rate lives in the TTS engine
 * (persisted) and every play site funnels through it, so this one pill governs sentence review, the
 * review popup, and the search popup at once (default 1.3×, up to 2×). Tap to cycle the presets
 * (1× → 1.3× → 1.5× → 1.75× → 2× → 1×). Render anywhere; all instances stay in sync via
 * subscribePlaybackRate. NOTE: this is the VOICE speed — distinct from DetailView's autoplay
 * "Speed per slide" pill, which is the slideshow dwell time between cards.
 */
// 1.0 → "1×", 1.3 → "1.3×", 2.0 → "2×" — Number#toString already drops a trailing ".0".
const fmt = (r: number): string => `${r}×`;

export const PlaybackSpeedToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [rate, setRate] = useState<number>(getPlaybackRate());
  useEffect(() => subscribePlaybackRate(setRate), []);

  const cycle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const presets = RATE_PRESETS as readonly number[];
    const idx = presets.indexOf(rate);
    setPlaybackRate(presets[(idx + 1) % presets.length] ?? presets[0]);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title="Voice speed for sentence playback"
      aria-label={`Voice speed ${fmt(rate)} — tap to change`}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold text-slate-600 hover:text-slate-800 transition-colors ${className}`}
    >
      {fmt(rate)}
    </button>
  );
};
