import { getItemSpelling, isPhraseItem, type ReviewHistory, type StoredItem } from '../types';
import { loopStanding } from '../server/src/shared/practice';
import { masteryLevelFor, type MasteryKey } from './srsAlgorithm';
import { sentenceReviewState } from './sentenceReviewState';
import type { StudyTaskType } from './studySession';

export interface StudyStats {
  /** Distinct due spellings (countDueSpellings). */
  due: number;
  /** How many items each mastery level holds: New for the never reviewed, the rest banded by stored display strength. */
  mastery: Record<MasteryKey, number>;
  total: number;
  /** The items' average display strength (0–100), a card never reviewed counting 0, as its badge shows it (New). */
  avgStrength: number;
  /** Consecutive days with a review, counting back from today, or from yesterday if today has none yet. */
  streak: number;
  /** Reviews today and on the six days before it, the chart's seven days. */
  weeklyReviews: number;
  /** The share of this week's study-session grades not rated Again, as a percentage; null with none. The review
   *  popup's Got it, always Good, isn't a recall test, so it doesn't count. */
  weeklyStudyRecallRate: number | null;
  totalLifetimeReviews: number;
  /** The longest run of correct answers a studied card holds now (its correctStreak, which Again and Reset end). */
  longestStreak: number;
  /** Up to three reviewed items, the most reviewed first. */
  mostReviewed: StoredItem[];
  /** Reviews on each of the last seven days, oldest first; `day` is that day's local midnight. */
  last7Days: { day: number; reviews: number }[];
}

/** The numbers counted over the items, which change with the library and the clock. */
export interface ItemStats extends Pick<StudyStats, 'due' | 'mastery' | 'total' | 'avgStrength' | 'longestStreak' | 'mostReviewed'> {
  /** The items' own review counts summed: the lifetime total while the history holds fewer reviews. */
  legacyReviewFloor: number;
}

/** The numbers counted over the review history, which change with the history and the day. */
export interface HistoryStats extends Pick<StudyStats, 'streak' | 'weeklyReviews' | 'weeklyStudyRecallRate' | 'last7Days'> {
  /** How many reviews the history knows of, however old. */
  lifetimeCount: number;
}

const STREAK_DAYS = 365;
/** The tasks a study session sets, whose grades say whether a card was recalled. */
const STUDY_TASKS: ReadonlySet<string> = new Set(['meaning', 'production', 'cloze', 'listening'] satisfies StudyTaskType[]);
const MOST_REVIEWED = 3;

const reviewsOf = (item: StoredItem) => item.srs?.totalReviews ?? 0;

/**
 * Whether classic Study takes the card once it's due: a card reviewed before that is neither in Today's practice,
 * where it is practiced, nor one you can say, which is done (server/src/shared/practice.ts). A new card isn't due:
 * new words enter through Today's sets, and Study introduces new phrases itself (isClassicNewCard).
 */
export const isClassicStudyCard = (item: StoredItem): boolean => loopStanding(item.srs) === 'reviewed';

/**
 * Whether classic Study introduces the card itself: a phrase never reviewed. Today's loop takes new words and the
 * learner's own sentences but no phrases, so without this a new phrase would never be studied.
 */
export const isClassicNewCard = (item: StoredItem): boolean => isPhraseItem(item) && !(reviewsOf(item) > 0);

/**
 * How many distinct spellings are due: studied (not archived or deleted), reviewed before, and with their next
 * review come, the 'due' of services/sentenceReviewState.ts, leaving out Today's practice and the cards you can say
 * (isClassicStudyCard). The review session buries same-spelling senses, so a spelling counts once. The Study
 * dashboard shows this number.
 */
export function countDueSpellings(items: readonly StoredItem[], now: number): number {
  const spellings = new Set<string>();
  for (const item of items) {
    if (item.isDeleted || item.isArchived || sentenceReviewState(item.srs, now) !== 'due' || !isClassicStudyCard(item)) continue;
    const spelling = getItemSpelling(item);
    if (spelling) spellings.add(spelling);
  }
  return spellings.size;
}

/**
 * When the dashboard's numbers next change with the clock alone: at the next local midnight, or sooner, when the first
 * card Study takes falls due. Never-reviewed cards are new whatever the time, and Today's cards never reach Study.
 */
export function nextStudyClockChange(items: readonly StoredItem[], now: number): number {
  let next = new Date(now).setHours(24, 0, 0, 0);
  for (const item of items) {
    const srs = item.srs;
    if (!srs || !(srs.totalReviews > 0) || !isClassicStudyCard(item)) continue;
    if (srs.nextReview > now && srs.nextReview < next) next = srs.nextReview;
  }
  return next;
}

/** When the next reviewed card falls due, and how many spellings will be due by the coming midnight. */
export interface StudyForecast {
  nextDueAt: number;
  dueByTomorrow: number;
}

/**
 * What 'All caught up' looks ahead to: when the next card Study takes falls due, and how many distinct spellings will
 * be due by the time tomorrow begins (the coming local midnight). Null when no such card is scheduled after `now`.
 */
export function studyForecast(items: readonly StoredItem[], now: number): StudyForecast | null {
  const midnight = new Date(now).setHours(24, 0, 0, 0);
  let nextDueAt = Infinity;
  const dueByMidnight = new Set<string>();
  for (const item of items) {
    const srs = item.srs;
    if (!srs || !(srs.totalReviews > 0) || item.isDeleted || item.isArchived || !isClassicStudyCard(item)) continue;
    if (srs.nextReview > now && srs.nextReview < nextDueAt) nextDueAt = srs.nextReview;
    if (srs.nextReview <= midnight) {
      const spelling = getItemSpelling(item);
      if (spelling) dueByMidnight.add(spelling);
    }
  }
  return nextDueAt === Infinity ? null : { nextDueAt, dueByTomorrow: dueByMidnight.size };
}

/**
 * The line under 'Review 42': how many of the session's cards are due and how many are new phrases ('40 due · 2 new'),
 * and, when more spellings are due (`dueTotal`, countDueSpellings) than the session holds, how many wait after it
 * ('· 70 more after this'). A part that is 0 is left out.
 */
export function startCaption(queue: readonly StoredItem[], dueTotal: number): string {
  const due = queue.filter(item => reviewsOf(item) > 0).length;
  const fresh = queue.length - due;
  return [
    due > 0 && `${due} due`,
    fresh > 0 && `${fresh} new`,
    dueTotal > due && `${dueTotal - due} more after this`,
  ].filter(Boolean).join(' · ');
}

/** A wait in its two largest units, a part that is 0 left out: '45m', '2h 10m', '3d 4h'; at least '1m'. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The study dashboard's numbers from one pass over the items (and countDueSpellings'). */
export function computeItemStats(items: readonly StoredItem[], now: number): ItemStats {
  const mastery: Record<MasteryKey, number> = { grandmaster: 0, mastered: 0, proficient: 0, learning: 0, struggling: 0, new: 0 };
  let strengthSum = 0;
  let legacyReviewFloor = 0;
  let longestStreak = 0;
  const mostReviewed: StoredItem[] = [];

  for (const item of items) {
    const srs = item.srs;
    const reviews = reviewsOf(item);
    const strength = srs?.memoryStrength ?? 0;
    const level = masteryLevelFor(strength, reviews);
    if (level) mastery[level.key]++;
    // The strength a never-reviewed card's seed stability gives it isn't anything learned, so it adds nothing.
    if (reviews > 0) strengthSum += strength;
    legacyReviewFloor += reviews;
    longestStreak = Math.max(longestStreak, srs?.correctStreak ?? 0);

    // The most reviewed items, earlier items first on ties; an item never reviewed isn't among them.
    if (reviews > 0 && (mostReviewed.length < MOST_REVIEWED || reviews > reviewsOf(mostReviewed[MOST_REVIEWED - 1]))) {
      let at = mostReviewed.length;
      while (at > 0 && reviewsOf(mostReviewed[at - 1]) < reviews) at--;
      mostReviewed.splice(at, 0, item);
      if (mostReviewed.length > MOST_REVIEWED) mostReviewed.pop();
    }
  }

  return {
    due: countDueSpellings(items, now),
    mastery,
    total: items.length,
    avgStrength: items.length > 0 ? Math.round(strengthSum / items.length) : 0,
    longestStreak,
    mostReviewed,
    legacyReviewFloor,
  };
}

/**
 * The study dashboard's numbers from one pass over the review history, for the day `now` falls on: any time that day
 * gives the same numbers. Review days are
 * found against precomputed local midnights rather than by formatting a date per review, which mattered once the
 * history grew to tens of thousands of reviews.
 */
export function computeHistoryStats(history: ReviewHistory, now: number): HistoryStats {
  // bounds[0] is tomorrow's midnight and bounds[d + 1] the midnight starting the day d days ago, so a
  // review on day d satisfies bounds[d] > reviewedAt >= bounds[d + 1].
  const today = new Date(now);
  const bounds = Array.from({ length: STREAK_DAYS + 1 }, (_, i) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1 - i).getTime());
  const dayOf = (time: number): number => {
    if (!(time < bounds[0] && time >= bounds[STREAK_DAYS])) return -1;
    let newer = 0, older = STREAK_DAYS;
    while (older - newer > 1) {
      const mid = (newer + older) >> 1;
      if (time >= bounds[mid]) older = mid;
      else newer = mid;
    }
    return newer;
  };

  const reviewsByDay = new Array<number>(STREAK_DAYS).fill(0);
  for (const time of history.olderTimes) {
    const day = dayOf(time);
    if (day >= 0) reviewsByDay[day]++;
  }
  // Only the recent reviews carry ratings, and they cover the week: the chart's seven days, today and the six
  // before it, so the weekly numbers and the chart's total count the same reviews.
  let weeklyReviews = 0;
  let weeklyStudyGrades = 0;
  let weeklyRecalled = 0;
  for (const event of history.recent) {
    const day = dayOf(event.reviewedAt);
    if (day >= 0) reviewsByDay[day]++;
    if (day >= 0 && day < 7) {
      weeklyReviews++;
      if (event.taskType && STUDY_TASKS.has(event.taskType)) {
        weeklyStudyGrades++;
        if (event.rating !== 'again') weeklyRecalled++;
      }
    }
  }

  let streak = 0;
  for (let day = 0; day < STREAK_DAYS; day++) {
    if (reviewsByDay[day] > 0) streak++;
    else if (day > 0) break;
  }

  return {
    streak,
    weeklyReviews,
    weeklyStudyRecallRate: weeklyStudyGrades > 0 ? Math.round((weeklyRecalled / weeklyStudyGrades) * 100) : null,
    lifetimeCount: history.olderCount + history.recent.length,
    last7Days: Array.from({ length: 7 }, (_, i) => {
      const day = 6 - i;
      return { day: bounds[day + 1], reviews: reviewsByDay[day] };
    }),
  };
}

/** The dashboard's numbers from the two passes: the lifetime total never falls below the items' own counts. */
export function combineStudyStats(itemStats: ItemStats, historyStats: HistoryStats): StudyStats {
  const { legacyReviewFloor, ...fromItems } = itemStats;
  const { lifetimeCount, ...fromHistory } = historyStats;
  return { ...fromItems, ...fromHistory, totalLifetimeReviews: Math.max(lifetimeCount, legacyReviewFloor) };
}

/** The study dashboard's numbers, from a pass over the items and one over the review history. */
export function computeStudyStats(
  items: readonly StoredItem[],
  history: ReviewHistory,
  now = Date.now(),
): StudyStats {
  return combineStudyStats(computeItemStats(items, now), computeHistoryStats(history, now));
}
