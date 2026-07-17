/**
 * FSRS v6 scheduling with lazy migration from the legacy fixed schedule.
 *
 * Design:
 * - Again / Hard / Good / Easy are deterministic (fuzz disabled)
 * - Existing fixed-schedule rows become FSRS rows on their next review
 * - The legacy "remember" action maps to Good
 * - memoryStrength is display-only, derived from stability
 */

import { Rating, State, createEmptyCard, fsrs, type Card, type CardInput, type Grade } from 'ts-fsrs';
import { SRSData, type ReviewRating } from '../types';

// Fixed review schedule (days). Each "remember" tap advances one step.
const SCHEDULE = [1, 2, 3, 5, 7, 12, 20, 25, 47, 84, 143, 180];
const DAY_MS = 86_400_000;
const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 3650,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['10m'],
  relearning_steps: ['10m'],
});

const ratingMap: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export class SRSAlgorithm {
  /**
   * Migrate old SRS data format to new format.
   * Strips legacy fields and infers schedule step from totalReviews/stability.
   */
  static migrate(srs: SRSData): SRSData {
    // Already has the required fields — just ensure display strength is up to date
    return {
      ...srs,
      memoryStrength: this.stabilityToDisplayStrength(srs.stability ?? 0.5),
      stability: srs.stability ?? 0.5,
      totalReviews: srs.totalReviews ?? 0,
      correctStreak: srs.correctStreak ?? 0,
      lastReviewDate: srs.lastReviewDate ?? 0,
    };
  }

  /**
   * Ensure SRS data exists with valid format, creating or migrating as needed.
   */
  static ensure(
    srs: SRSData | undefined,
    fallbackId: string,
    fallbackType: 'vocab' | 'phrase' | 'sentence'
  ): SRSData {
    if (srs) {
      return this.migrate(srs);
    }
    return this.createNew(fallbackId, fallbackType);
  }

  /**
   * Initialize new SRS data for an item.
   */
  static createNew(id: string, type: 'vocab' | 'phrase' | 'sentence'): SRSData {
    const now = Date.now();
    return {
      id,
      type,
      nextReview: now, // Due immediately for first review
      interval: 0,
      memoryStrength: 0,
      lastReviewDate: 0, // 0 = never reviewed
      totalReviews: 0,
      correctStreak: 0,
      stability: 0.5, // Initial stability (half a day)
      scheduler: 'fsrs-v6',
      difficulty: 0,
      lapses: 0,
      fsrsState: State.New,
      learningSteps: 0,
      scheduledDays: 0,
    };
  }

  private static toFsrsCard(srs: SRSData, now: number): CardInput {
    if ((srs.totalReviews || 0) === 0) {
      const empty = createEmptyCard(new Date(srs.nextReview || now));
      return { ...empty, due: new Date(srs.nextReview || now) };
    }
    const lastReview = srs.lastReviewDate || Math.max(0, now - Math.max(1, srs.interval) * 60_000);
    return {
      due: new Date(srs.nextReview || now),
      stability: Math.max(0.1, Number(srs.stability) || 0.5),
      difficulty: Math.min(10, Math.max(1, Number(srs.difficulty) || 5)),
      elapsed_days: Math.max(0, Math.round((now - lastReview) / DAY_MS)),
      scheduled_days: Math.max(0, srs.scheduledDays ?? Math.round((srs.interval || 0) / 1440)),
      learning_steps: Math.max(0, srs.learningSteps || 0),
      reps: Math.max(1, srs.totalReviews || 0),
      lapses: Math.max(0, srs.lapses || 0),
      state: srs.fsrsState ?? State.Review,
      last_review: new Date(lastReview),
    };
  }

  private static fromFsrsCard(
    previous: SRSData,
    card: Card,
    rating: ReviewRating,
    reviewedAt: number,
  ): SRSData {
    const interval = Math.max(1, Math.round((card.due.getTime() - reviewedAt) / 60_000));
    return {
      ...previous,
      nextReview: card.due.getTime(),
      interval,
      memoryStrength: this.stabilityToDisplayStrength(card.stability),
      lastReviewDate: reviewedAt,
      totalReviews: card.reps,
      correctStreak: rating === 'again' ? 0 : (previous.correctStreak || 0) + 1,
      stability: card.stability,
      scheduler: 'fsrs-v6',
      difficulty: card.difficulty,
      lapses: card.lapses,
      fsrsState: card.state,
      learningSteps: card.learning_steps,
      scheduledDays: card.scheduled_days,
    };
  }

  static updateAfterRating(srs: SRSData, rating: ReviewRating, now = Date.now()): SRSData {
    const card = this.toFsrsCard(srs, now);
    const result = scheduler.next(card, new Date(now), ratingMap[rating]);
    return this.fromFsrsCard(srs, result.card, rating, now);
  }

  static previewRatings(srs: SRSData, now = Date.now()): Record<ReviewRating, SRSData> {
    return {
      again: this.updateAfterRating(srs, 'again', now),
      hard: this.updateAfterRating(srs, 'hard', now),
      good: this.updateAfterRating(srs, 'good', now),
      easy: this.updateAfterRating(srs, 'easy', now),
    };
  }

  /**
   * Calculate step penalty for overdue items.
   * Penalty is proportional to how late the review is relative to the expected interval.
   * Being 8 days late on a 25-day interval (32%) is very different from 8 days late on a 1-day interval.
   */
  static getOverduePenalty(srs: SRSData, now = Date.now()): number {
    if (srs.scheduler === 'fsrs-v6') return 0;
    const daysOverdue = Math.max(0, (now - srs.nextReview) / (1000 * 60 * 60 * 24));

    // Grace period: no penalty if less than 14 days overdue in absolute terms
    if (daysOverdue <= 14) return 0;

    // Compare overdue duration to the item's current interval
    const step = Math.max(0, srs.totalReviews - 1);
    const expectedInterval = SCHEDULE[Math.min(step, SCHEDULE.length - 1)] || 1;
    const overdueRatio = daysOverdue / expectedInterval;

    if (overdueRatio > 4) return 2;
    if (overdueRatio > 2) return 1;
    return 0;
  }

  /**
   * Update SRS data after the user taps "remember".
   * Advances one step in the schedule, minus any overdue penalty.
   */
  static updateAfterRemember(srs: SRSData, now = Date.now()): SRSData {
    return this.updateAfterRating(srs, 'good', now);
  }

  /**
   * Map stability (days) to a display strength score (0–100) for mastery badges.
   *
   * Mapping (approximate):
   *   stability  1d → 13  (Struggling)
   *   stability  3d → 25  (Struggling)
   *   stability  7d → 37  (Learning)
   *   stability 12d → 47  (Learning)
   *   stability 25d → 59  (Proficient)
   *   stability 47d → 70  (Mastered)
   *   stability 84d → 80  (Mastered)
   *   stability143d → 90  (Grandmaster)
   *   stability180d → 94  (Grandmaster)
   */
  private static stabilityToDisplayStrength(stability: number): number {
    if (stability <= 0) return 0;
    return Math.min(100, Math.round(18 * Math.log(1 + stability)));
  }

  /**
   * Calculate mastery level for display.
   * Based on memory strength score (0–100):
   *   0–10:  New        (Gray/Slate)
   *  10–30:  Struggling (Orange)
   *  30–50:  Learning   (Amber)
   *  50–70:  Proficient (Blue)
   *  70–85:  Mastered   (Emerald/Green)
   *  85–100: Grandmaster(Purple)
   */
  static getMasteryLevel(srs: SRSData): { label: string; color: string; percentage: number } {
    // Recalculate display strength from stability to ensure consistency
    const strength = this.stabilityToDisplayStrength(srs.stability);

    if (strength >= 85) {
      return { label: 'Grandmaster', color: 'purple', percentage: strength };
    } else if (strength >= 70) {
      return { label: 'Mastered', color: 'emerald', percentage: strength };
    } else if (strength >= 50) {
      return { label: 'Proficient', color: 'blue', percentage: strength };
    } else if (strength >= 30) {
      return { label: 'Learning', color: 'amber', percentage: strength };
    } else if (strength >= 10) {
      return { label: 'Struggling', color: 'orange', percentage: strength };
    } else {
      return { label: 'New', color: 'slate', percentage: strength };
    }
  }

  /**
   * Get the fixed schedule for external reference.
   */
  static getSchedule(): readonly number[] {
    return SCHEDULE;
  }
}
