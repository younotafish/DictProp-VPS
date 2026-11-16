import { useEffect, useState } from 'react';

interface AutoPlayCountdownProps {
  /** When the running session ends; null while stopped or paused. */
  deadline: number | null;
  /** The time left, standing still while auto-play is paused; null otherwise. */
  frozenRemainingMs: number | null;
  /** The Duration preset, shown while stopped. */
  minutes: number;
}

/**
 * The auto-play duration: the preset while stopped, the time left while playing, and the time left standing still
 * while paused. It ticks by itself on each second boundary, so the card around it doesn't re-render every second.
 */
export function AutoPlayCountdown({ deadline, frozenRemainingMs, minutes }: AutoPlayCountdownProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tickAtNextSecond = () => {
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) timer = setTimeout(() => { setTick(tick => tick + 1); tickAtNextSecond(); }, remainingMs % 1000 || 1000);
    };
    tickAtNextSecond();
    return () => clearTimeout(timer);
  }, [deadline]);

  const remainingMs = deadline !== null ? deadline - Date.now() : frozenRemainingMs;
  if (remainingMs === null) return <>{minutes}m</>;
  const remainingSec = Math.ceil(Math.max(0, remainingMs) / 1000);
  return <>{Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, '0')}</>;
}
