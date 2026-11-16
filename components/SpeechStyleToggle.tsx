import React, { useEffect, useState } from 'react';
import { chooseTtsStyle, getTtsStyle, subscribeTtsStyle, type TtsStyle } from '../services/ttsSettings';
import { getPlaybackState, type PlaybackState } from '../services/neuralTts';

/**
 * Shared Clear ⇄ Casual speech-style switch. The global fallback lives in the TTS engine (persisted),
 * and every play site routes through it. Sentence review can also use `onChange` to retain a choice
 * on the sentence itself. Render it anywhere; all instances stay in sync via subscribeTtsStyle.
 * `onStyleClicked` hears a click that changes the style, with what was playing before it, still inside the click so a
 * replay may start there (iOS plays only from a gesture); the engine itself just stops what was playing. Such a click is
 * the user's choice (chooseTtsStyle), so sentence auto-play plans its preload again whichever switch it was.
 */
export const SpeechStyleToggle: React.FC<{
  className?: string;
  onChange?: (style: TtsStyle) => void;
  onStyleClicked?: (style: TtsStyle, before: PlaybackState) => void;
}> = ({ className = '', onChange, onStyleClicked }) => {
  const [style, setStyle] = useState<TtsStyle>(getTtsStyle());
  useEffect(() => subscribeTtsStyle(setStyle), []);

  const opt = (value: TtsStyle, label: string, title: string) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const before = getPlaybackState();
        const changed = value !== getTtsStyle();
        chooseTtsStyle(value);
        onChange?.(value);
        if (changed) onStyleClicked?.(value, before);
      }}
      aria-pressed={style === value}
      title={title}
      className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
        style === value ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-full bg-slate-100 p-0.5 ${className}`}
      title="Speech style"
      role="group"
      aria-label="Speech style"
    >
      {opt('clear', 'Clear', 'Clear: crisp, fully-articulated pronunciation')}
      {opt('casual', 'Casual', 'Casual: fast, natural, reduced everyday speech')}
    </div>
  );
};
