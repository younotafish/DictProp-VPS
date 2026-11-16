import { getItemSpelling, type ReviewHistory, type StoredItem } from '../types';
import { masteryLevelFor, type MasteryKey } from './srsAlgorithm';
import { sentenceReviewState } from './sentenceReviewState';

export interface StudyStats {
  /** Distinct due spellings (countDueSpellings). */
  due: number;
  /** How many items each mastery level holds: New for the never reviewed, the rest banded by stored display strength. */
  mastery: Record<MasteryKey, number>;
  total: number;
  avgStrength: number;
  /** Consecutive days with a review, counting back from today, or from yesterday if today has none yet. */
  streak: number;
  weeklyReviews: number;
  weeklyRecallRate: number;
  totalLifetimeReviews: number;
  longestStreak: number;
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
export interface HistoryStats extends Pick<StudyStats, 'streak' | 'weeklyReviews' | 'weeklyRecallRate' | 'last7Days'> {
  /** How many reviews the history knows of, however old. */
  lifetimeCount: number;
}

const STREAK_DAYS = 365;
const MOST_REVIEWED = 3;

const reviewsOf = (item: StoredItem) => item.srs?.totalReviews ?? 0;

/**
 * How many distinct spellings are due: studied (not archived or deleted), reviewed before, and with their next
 * review come, the 'due' of services/sentenceReviewState.ts. A never-reviewed card waits with the new ones
 * instead, and the review session buries same-spelling senses, so a spelling counts once. The Study dashboard
 * shows this number.
 */
export function countDueSpellings(items: readonly StoredItem[], now: number): number {
  const spellings = new Set<string>();
  for (const item of items) {
    if (item.isDeleted || item.isArchived || sentenceReviewState(item.srs, now) !== 'due') continue;
    const spelling = getItemSpelling(item);
    if (spelling) spellings.add(spelling);
  }
  return spellings.size;
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
    const strength = srs?.memoryStrength ?? 0;
    const level = masteryLevelFor(strength, srs?.totalReviews ?? 0);
    if (level) mastery[level.key]++;
    strengthSum += strength;
    legacyReviewFloor += srs?.totalReviews ?? 0;
    longestStreak = Math.max(longestStreak, srs?.correctStreak ?? 0);

    // The most reviewed items, earlier items first on ties.
    const reviews = reviewsOf(item);
    if (mostReviewed.length < MOST_REVIEWED || reviews > reviewsOf(mostReviewed[MOST_REVIEWED - 1])) {
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
 * The study dashboard's numbers from one pass over the review history, for the day `now` falls on. Review days are
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

  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoTime = weekAgo.getTime();

  const reviewsByDay = new Array<number>(STREAK_DAYS).fill(0);
  for (const time of history.olderTimes) {
    const day = dayOf(time);
    if (day >= 0) reviewsByDay[day]++;
  }
  // Only the recent reviews carry ratings, and they cover the week.
  let weeklyReviews = 0;
  let weeklyRecalled = 0;
  for (const event of history.recent) {
    const day = dayOf(event.reviewedAt);
    if (day >= 0) reviewsByDay[day]++;
    if (event.reviewedAt >= weekAgoTime) {
      weeklyReviews++;
      if (event.rating !== 'again') weeklyRecalled++;
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
    weeklyRecallRate: weeklyReviews > 0 ? Math.round((weeklyRecalled / weeklyReviews) * 100) : 0,
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
