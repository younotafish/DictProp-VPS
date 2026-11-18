import type { ThemesResponse } from '../../server/src/shared/item-themes';
import type { SetDaysResponse } from '../../server/src/shared/review';
import { requestJson } from '../http';

// Today's two reads: the theme each item belongs to (the server's classifier writes them) and, for the streak, how many
// items were first met in a set on each past day. Both are read-only; the loop's own progress travels as reviews.

/** The theme rows changed after `after` (0: every row with a theme). */
export const loadThemes = async (after: number): Promise<ThemesResponse> =>
  requestJson<ThemesResponse>(`/api/themes?after=${Math.max(0, Math.floor(after))}`, undefined, 'Load themes');

/**
 * Items first met in a set per local day, for the days before today. `tzOffsetMinutes` is minutes east of UTC (the
 * negation of Date#getTimezoneOffset), so the server's days are this device's.
 */
export const loadSetDays = async (tzOffsetMinutes: number): Promise<SetDaysResponse> =>
  requestJson<SetDaysResponse>(`/api/reviews/set-days?tzOffset=${Math.round(tzOffsetMinutes)}`, undefined, 'Load set days');
