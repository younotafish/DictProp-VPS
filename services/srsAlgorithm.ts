/**
 * Learning-progress records: new, migrated and reset schedules, passive exposure, and mastery display.
 * Scheduling a review with FSRS v6 lives in fsrsScheduler.ts, which loads only where reviews happen.
 *
 * - memoryStrength is display-only, derived from stability
 * - Passive listening records recency for queue rotation without changing mastery
 */

import { SRSData } from '../types';

// Fixed review schedule (days). Each "remember" tap advances one step.
const SCHEDULE = [1, 2, 3, 5, 7, 12, 20, 25, 47, 84, 143, 180];

export class SRSAlgorithm {
  /**
   * Migrate old SRS data format to new format.
   * Strips legacy fields and infers schedule step from totalReviews/stability.
   */
  static migrate(srs: SRSData): SRSData {
    const totalReviews = srs.totalReviews ?? 0;
    const isUnreviewedSentence = srs.type === 'sentence' && totalReviews === 0;
    const stability = isUnreviewedSentence ? 0.5 : (srs.stability ?? 0.5);
    // Already has the required fields — just ensure display strength is up to date
    return {
      ...srs,
      // A never-reviewed sentence is still unmemorized even though FSRS needs a non-zero seed
      // stability. Keep this correction sentence-scoped so legacy word-card display stays untouched.
      memoryStrength: isUnreviewedSentence
        ? 0
        : this.stabilityToDisplayStrength(stability),
      stability,
      totalReviews,
      correctStreak: srs.correctStreak ?? 0,
      lastReviewDate: srs.lastReviewDate ?? 0,
      lastExposureDate: srs.lastExposureDate ?? 0,
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
      lastExposureDate: 0,
      totalReviews: 0,
      correctStreak: 0,
      stability: 0.5, // Initial stability (half a day)
      scheduler: 'fsrs-v6',
      difficulty: 0,
      lapses: 0,
      fsrsState: 0, // State.New in ts-fsrs
      learningSteps: 0,
      scheduledDays: 0,
    };
  }

  /**
   * Fresh progress for an item the user resets. Its review clock is the moment of the reset: the merges on
   * each device and on the server keep the schedule with the newest review, so they keep the reset too.
   * FSRS never reads that clock for a card with no reviews.
   */
  static reset(id: string, type: 'vocab' | 'phrase' | 'sentence', now = Date.now()): SRSData {
    return { ...this.createNew(id, type), nextReview: now, lastReviewDate: now };
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

  /** Record a completed passive listen without changing any memorization or FSRS state. */
  static updateAfterExposure(srs: SRSData, now = Date.now()): SRSData {
    return {
      ...srs,
      lastExposureDate: Math.max(srs.lastExposureDate ?? 0, now),
    };
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
  static stabilityToDisplayStrength(stability: number): number {
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
