import { useEffect, useState } from 'react';

/**
 * The auto-play duration: the preset while stopped, the time left while playing. It ticks by itself on each
 * second boundary, so the card around it doesn't re-render every second.
 */
export function AutoPlayCountdown({ startedAt, minutes }: { startedAt: number | null; minutes: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tickAtNextSecond = () => {
      const remainingMs = startedAt + minutes * 60_000 - Date.now();
      if (remainingMs > 0) timer = setTimeout(() => { setTick(tick => tick + 1); tickAtNextSecond(); }, remainingMs % 1000 || 1000);
    };
    tickAtNextSecond();
    return () => clearTimeout(timer);
  }, [startedAt, minutes]);

  if (startedAt === null) return <>{minutes}m</>;
  const remainingSec = Math.ceil(Math.max(0, startedAt + minutes * 60_000 - Date.now()) / 1000);
  return <>{Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, '0')}</>;
}
