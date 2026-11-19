import { isSentenceItem, type SentenceData, type StoredItem } from '../../types';
import { GRADUATION_STABILITY_DAYS, loopStanding, type LoopStanding } from '../../server/src/shared/practice';
import { catalogProgressKind } from '../catalogProgressIdentity';

// Which items Today's loop takes (the learner's own saved sentences: Today teaches sentences, never single words), where
// each stands in it, and the local days its rules count by. Membership itself (practicing, can say it, kept passive)
// rides on the item's schedule and changes only in reviews (server/src/shared/practice.ts).

/**
 * Whether a sentence is one the learner saved, not the progress record of a Real Life or essay line. Each catalog field
 * counts on its own: the first Real Life records were saved before catalogKind existed.
 */
export function isOwnSentence(item: StoredItem): item is StoredItem & { type: 'sentence'; data: SentenceData } {
  return isSentenceItem(item) && catalogProgressKind(item) === null && !item.data.catalogKind && !item.data.catalogSentenceId;
}

/** A sentence's Chinese translation, from its analysis: '' until the Mac's cycle has written one. */
export function sentenceTranslation(data: SentenceData): string {
  const translation = data.analysis?.translation;
  return typeof translation === 'string' ? translation.trim() : '';
}

/**
 * Whether the loop takes the item: one of the learner's own saved sentences, live (not deleted or archived), with its
 * text and a translation, which every cue shows. Word cards, phrases and catalog lines stay out: words are reviewed in
 * Card review, and Real Life and the Essays keep their own progress.
 */
export function isLoopEligible(item: StoredItem): boolean {
  if (item.isDeleted || item.isArchived) return false;
  return isOwnSentence(item) && typeof item.data.text === 'string' && item.data.text.trim() !== '' &&
    sentenceTranslation(item.data) !== '';
}

/**
 * Where the item stands in the loop, from its schedule: new to the loop (no decision yet, though it may have classic
 * reviews), practicing, can say it, or kept passive.
 */
export const itemStanding = (item: StoredItem): LoopStanding => loopStanding(item.srs);

/**
 * The local midnight that starts the day `time` falls on, moved `offsetDays` days (back when negative). It counts in
 * calendar days, so a day that gains or loses an hour to daylight saving is still one day.
 */
export function localDayStart(time: number, offsetDays = 0): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
}

/** The local day `time` falls on, as 'YYYY-MM-DD': the set-days endpoint's keys and the day pin's. */
export function localDayKey(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether the item waits in today's practice: in the loop, practicing, its time come, and not reviewed since local
 * midnight. An item practiced, joined or missed today waits for tomorrow; a session's own requeue is today's repetition.
 * `todayStart` is localDayStart(now), which a caller checking many items can pass.
 */
export function isPracticeDue(item: StoredItem, now: number, todayStart = localDayStart(now)): boolean {
  const srs = item.srs;
  return isLoopEligible(item) && loopStanding(srs) === 'practicing' && (srs?.nextReview ?? 0) <= now &&
    (srs?.lastReviewDate ?? 0) < todayStart;
}

// The stability, in days, at which each graduation dot after the first fills. The last is the stability graduation
// needs, so five dots read "the next unaided spoken success after a long enough gap makes it one you can say".
const DOT_STABILITY_DAYS = [1.5, 5, 12, GRADUATION_STABILITY_DAYS] as const;

/** How many dots the graduation progress row has. */
export const GRADUATION_DOTS = DOT_STABILITY_DAYS.length + 1;

/**
 * How many of a practice item's graduation dots are filled, from 1 (just joined) to GRADUATION_DOTS, by its FSRS
 * stability: ●○○○○ below 1.5 days, then one more at each of 1.5, 5, 12 and 21 days.
 */
export function graduationDots(stability: number | undefined): number {
  const days = Number(stability) || 0;
  return 1 + DOT_STABILITY_DAYS.filter(threshold => days >= threshold).length;
}
