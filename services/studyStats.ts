import { getItemSpelling, type ReviewEvent, type StoredItem } from '../types';

export interface StudyStats {
  /** Distinct due spellings: the review session buries same-spelling senses, so the count follows it. */
  due: number;
  grandmaster: number;
  mastered: number;
  proficient: number;
  learning: number;
  struggling: number;
  newItems: number;
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

const STREAK_DAYS = 365;
const MOST_REVIEWED = 3;

const reviewsOf = (item: StoredItem) => item.srs?.totalReviews ?? 0;

/**
 * The study dashboard's numbers, from one pass over the items and one over the review history. Review
 * days are found against precomputed local midnights rather than by formatting a date per event, which
 * mattered once the history grew to tens of thousands of reviews.
 */
export function computeStudyStats(
  items: readonly StoredItem[],
  reviewEvents: readonly ReviewEvent[],
  now = Date.now(),
): StudyStats {
  const dueSpellings = new Set<string>();
  let grandmaster = 0, mastered = 0, proficient = 0, learning = 0, struggling = 0, newItems = 0;
  let strengthSum = 0;
  let legacyReviewFloor = 0;
  let longestStreak = 0;
  const mostReviewed: StoredItem[] = [];

  for (const item of items) {
    const srs = item.srs;
    if ((srs?.nextReview ?? 0) <= now) {
      const spelling = getItemSpelling(item);
      if (spelling) dueSpellings.add(spelling);
    }

    const strength = srs?.memoryStrength ?? 0;
    if (strength >= 85) grandmaster++;
    else if (strength >= 70) mastered++;
    else if (strength >= 50) proficient++;
    else if (strength >= 30) learning++;
    else if (strength >= 10) struggling++;
    else if (strength < 10) newItems++;
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
  let weeklyReviews = 0;
  let weeklyRecalled = 0;
  for (const event of reviewEvents) {
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
    due: dueSpellings.size,
    grandmaster,
    mastered,
    proficient,
    learning,
    struggling,
    newItems,
    total: items.length,
    avgStrength: items.length > 0 ? Math.round(strengthSum / items.length) : 0,
    streak,
    weeklyReviews,
    weeklyRecallRate: weeklyReviews > 0 ? Math.round((weeklyRecalled / weeklyReviews) * 100) : 0,
    totalLifetimeReviews: Math.max(reviewEvents.length, legacyReviewFloor),
    longestStreak,
    mostReviewed,
    last7Days: Array.from({ length: 7 }, (_, i) => {
      const day = 6 - i;
      return { day: bounds[day + 1], reviews: reviewsByDay[day] };
    }),
  };
}
