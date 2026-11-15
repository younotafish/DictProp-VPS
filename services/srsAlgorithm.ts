/**
 * Learning-progress records: new, migrated and reset schedules, passive exposure, and mastery display.
 * Scheduling a review with FSRS v6 lives in fsrsScheduler.ts, which loads only where reviews happen.
 *
 * - memoryStrength is display-only, derived from stability
 * - Passive listening records recency for queue rotation without changing mastery
 */

import { SRSData } from '../types';

export class SRSAlgorithm {
  /**
   * Fills the fields older rows lack (display strength from stability, counts, dates) and keeps the rest; a
   * never-reviewed sentence shows strength 0.
   */
  static migrate(srs: SRSData): SRSData {
    const totalReviews = srs.totalReviews ?? 0;
    const isUnreviewedSentence = srs.type === 'sentence' && totalReviews === 0;
    const stability = isUnreviewedSentence ? 0.5 : (srs.stability ?? 0.5);
    return {
      ...srs,
      // A never-reviewed sentence is still unmemorized even though FSRS needs a non-zero seed
      // stability. Keep this correction sentence-scoped so legacy word-card display stays untouched.
      memoryStrength: isUnreviewedSentence
        ? 0
        : SRSAlgorithm.stabilityToDisplayStrength(stability),
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
      return SRSAlgorithm.migrate(srs);
    }
    return SRSAlgorithm.createNew(fallbackId, fallbackType);
  }

  /**
   * Initialize new SRS data for an item.
   */
  static createNew(id: string, type: 'vocab' | 'phrase' | 'sentence', now = Date.now()): SRSData {
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
    return { ...SRSAlgorithm.createNew(id, type, now), nextReview: now, lastReviewDate: now };
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
   * Mapping (18·ln(1 + stability), rounded):
   *   stability   1d → 12  (Struggling)
   *   stability   3d → 25  (Struggling)
   *   stability   7d → 37  (Learning)
   *   stability  12d → 46  (Learning)
   *   stability  25d → 59  (Proficient)
   *   stability  47d → 70  (Mastered)
   *   stability  84d → 80  (Mastered)
   *   stability 143d → 89  (Grandmaster)
   *   stability 180d → 94  (Grandmaster)
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
    const strength = SRSAlgorithm.stabilityToDisplayStrength(srs.stability);

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
}
