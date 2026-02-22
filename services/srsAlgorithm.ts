/**
 * Fixed-Schedule SRS Algorithm — Positive-Signal-Only
 *
 * Design:
 * - Only one event: "remember" (user taps green bar)
 * - Skip produces no data — card stays due
 * - Interval follows a fixed schedule: each "remember" advances one step
 * - Overdue items regress steps (implicit decay)
 * - memoryStrength is display-only, derived from stability
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
    fallbackType: 'vocab' | 'phrase'
  ): SRSData {
    if (srs) {
      return this.migrate(srs);
    }
    return this.createNew(fallbackId, fallbackType);
  }

  /**
   * Initialize new SRS data for an item.
   */
  static createNew(id: string, type: 'vocab' | 'phrase'): SRSData {
    return {
      id,
      type,
      nextReview: Date.now(), // Due immediately for first review
      interval: 0,
      memoryStrength: 0,
      lastReviewDate: 0, // 0 = never reviewed
      totalReviews: 0,
      correctStreak: 0,
      stability: 0.5, // Initial stability (half a day)
    };
  }

  /**
   * Calculate step penalty for overdue items.
   * The longer an item has been overdue (sitting unanswered), the more steps back.
   */
  static getOverduePenalty(srs: SRSData): number {
    const now = Date.now();
    const daysOverdue = Math.max(0, (now - srs.nextReview) / (1000 * 60 * 60 * 24));

    if (daysOverdue > 90) return 3;
    if (daysOverdue > 30) return 2;
    if (daysOverdue > 7) return 1;
    return 0;
  }

  /**
   * Update SRS data after the user taps "remember".
   * Advances one step in the schedule, minus any overdue penalty.
   */
  static updateAfterRemember(srs: SRSData): SRSData {
    const now = Date.now();
    const penalty = this.getOverduePenalty(srs);

    // Current step = totalReviews, apply penalty, then advance by 1
    const penalizedStep = Math.max(0, srs.totalReviews - penalty);
    const nextStep = Math.min(penalizedStep + 1, SCHEDULE.length);

    // Look up interval from schedule (0-indexed, step 1 = SCHEDULE[0])
    const scheduleIndex = Math.min(nextStep - 1, SCHEDULE.length - 1);
    const intervalDays = nextStep > 0 ? SCHEDULE[Math.max(0, scheduleIndex)] : SCHEDULE[0];

    const intervalMinutes = Math.round(intervalDays * 24 * 60);
    const newStability = intervalDays;
    const displayStrength = this.stabilityToDisplayStrength(newStability);

    return {
      ...srs,
      memoryStrength: displayStrength,
      lastReviewDate: now,
      totalReviews: nextStep,
      correctStreak: penalty > 0 ? 0 : srs.correctStreak + 1,
      stability: newStability,
      interval: intervalMinutes,
      nextReview: now + intervalMinutes * 60 * 1000,
    };
  }

  /**
   * Get current retention probability based on time since last review.
   * R = 0.9^(elapsed / stability) — when elapsed = stability, R = 90%.
   */
  static getRetentionProbability(srs: SRSData): number {
    const now = Date.now();
    const daysSinceReview = (now - srs.lastReviewDate) / (1000 * 60 * 60 * 24);
    const stability = Math.max(0.1, srs.stability);

    return Math.pow(0.9, daysSinceReview / stability);
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
