import React, { useEffect, useState } from 'react';
import { getTtsStyle, setTtsStyle, subscribeTtsStyle, type TtsStyle } from '../services/ttsSettings';

/**
 * Global Clear ⇄ Casual speech-style switch. The choice lives in the TTS engine (persisted), and
 * every play site routes through it — so one toggle governs word review, sentence review, and the
 * global-search popup at once. Render it anywhere; all instances stay in sync via subscribeTtsStyle.
 */
export const SpeechStyleToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [style, setStyle] = useState<TtsStyle>(getTtsStyle());
  useEffect(() => subscribeTtsStyle(setStyle), []);

  const opt = (value: TtsStyle, label: string, title: string) => (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setTtsStyle(value); }}
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
