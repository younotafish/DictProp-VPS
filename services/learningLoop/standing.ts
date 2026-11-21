import { isSentenceItem, type SentenceData, type StoredItem } from '../../types';
import { catalogProgressKind } from '../catalogProgressIdentity';

// Which items Today's units take (the learner's own saved sentences: Today teaches sentences, never single words), and
// the local days its rules count by. Where a sentence stands is its schedule alone, the one the Sentences tab reads
// (services/sentenceOrdering.ts needsReview).

/**
 * Whether a sentence is one the learner saved, not the progress record of a Real Life or essay line. Each catalog field
 * counts on its own: the first Real Life records were saved before catalogKind existed.
 */
export function isOwnSentence(item: StoredItem): item is StoredItem & { type: 'sentence'; data: SentenceData } {
  return isSentenceItem(item) && catalogProgressKind(item) === null && !item.data.catalogKind && !item.data.catalogSentenceId;
}

/**
 * Whether Today's units take the item: one of the learner's own saved sentences, live (not deleted or archived), with
 * its text. No translation is needed: the lesson shows the sentence's analysis, or fetches it, as on the Sentences tab.
 * Word cards, phrases and catalog lines stay out: words are reviewed in Card review, and Real Life and the Essays keep
 * their own progress.
 */
export function isLoopEligible(item: StoredItem): boolean {
  if (item.isDeleted || item.isArchived) return false;
  return isOwnSentence(item) && typeof item.data.text === 'string' && item.data.text.trim() !== '';
}

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
