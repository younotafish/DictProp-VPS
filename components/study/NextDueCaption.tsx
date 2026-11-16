import { useEffect, useState } from 'react';
import { formatCountdown, type StudyForecast } from '../../services/studyStats';

/** How often the countdown is drawn again. */
const REDRAW_MS = 30_000;

/**
 * The caption under the dashboard's 'All caught up': 'Next card due in 2h 10m · 34 by tomorrow', leaving out the count
 * when none will be due by tomorrow, and nothing at all with no forecast. It draws itself again every 30 seconds, so
 * the countdown moves on while the dashboard around it, and its counts, stay as they are.
 */
export function NextDueCaption({ forecast }: { forecast: StudyForecast | null }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!forecast) return;
    const timer = window.setInterval(() => redraw(count => count + 1), REDRAW_MS);
    return () => window.clearInterval(timer);
  }, [forecast]);

  if (!forecast) return null;
  return (
    <p className="mt-1 text-xs text-slate-500">
      Next card due in {formatCountdown(forecast.nextDueAt - Date.now())}
      {forecast.dueByTomorrow > 0 && ` · ${forecast.dueByTomorrow} by tomorrow`}
    </p>
  );
}
