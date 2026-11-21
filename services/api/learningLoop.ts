import type { ThemesResponse } from '../../server/src/shared/item-themes';
import type { SetDaysResponse } from '../../server/src/shared/review';
import { requestJson } from '../http';

// Today's two reads: the theme each of the learner's sentences belongs to (the server's classifier writes them)
// and, for the streak, how many sentences were Got it'd in Today's units on each past day. Both are read-only: a unit's
// progress travels as the reviews its lesson records.

/** The theme rows changed after `after` (0: every row with a theme). */
export const loadThemes = async (after: number): Promise<ThemesResponse> =>
  requestJson<ThemesResponse>(`/api/themes?after=${Math.max(0, Math.floor(after))}`, undefined, 'Load themes');

/**
 * The distinct sentences Got it'd in Today's units per local day ('quick' reviews in 'set:' sessions, and a v3 set's
 * 'triage' ones), for the days before today. `tzOffsetMinutes` is minutes east of UTC (the negation of
 * Date#getTimezoneOffset), so the server's days are this device's.
 */
export const loadSetDays = async (tzOffsetMinutes: number): Promise<SetDaysResponse> =>
  requestJson<SetDaysResponse>(`/api/reviews/set-days?tzOffset=${Math.round(tzOffsetMinutes)}`, undefined, 'Load set days');
