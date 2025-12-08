/**
 * Advanced SRS Algorithm - SuperMemo/Shanbay-inspired Memory Strength System
 * 
 * Core Principles:
 * 1. Memory Strength (0-100): Hidden metric that reflects true retention
 * 2. Dynamic Intervals: Based on forgetting curves and strength
 * 3. Task Difficulty Weighting: Different tasks provide different signals
 * 4. Time Decay: Strength decreases over time without review
 * 5. Stability Tracking: How long memories last before forgetting
 */

import { SRSData, TaskType, TaskPerformance } from '../types';

// Task difficulty multipliers (harder tasks boost strength more)
const TASK_WEIGHTS: Record<TaskType, number> = {
  recognition: 1.0,  // Easiest: Just recognize the word
  recall: 1.3,       // Medium: Recall meaning from word
  listening: 1.5,    // Harder: Audio-only recognition
  typing: 1.8,       // Hard: Must produce the word
  sentence: 2.0,     // Hardest: Use in context
};

// Quality to strength delta mapping
const QUALITY_IMPACT: Record<number, number> = {
  0: -25,  // Complete fail - major strength loss
  1: -10,  // Hard fail - moderate loss
  2: -5,   // Barely remembered - small loss
  3: 5,    // Good - small gain
  4: 12,   // Very good - moderate gain
  5: 20,   // Perfect - large gain
};

export class SRSAlgorithm {
  /**
   * Migrate old SRS data format to new format with memory strength
   */
  static migrate(srs: SRSData): SRSData {
    if (typeof srs.memoryStrength === 'number') return srs;
    
    const reviewCount = srs.history?.length || 0;
    const correctCount = srs.history?.filter(q => q >= 3).length || 0;
    const accuracy = reviewCount > 0 ? correctCount / reviewCount : 0;
    
    let initialStrength = 0;
    if (srs.easeFactor > 2.5) initialStrength += 30;
    if (srs.interval > 1440) initialStrength += 40;
    if (accuracy > 0.7) initialStrength += 30;
    
    return {
      ...srs,
      memoryStrength: Math.min(100, initialStrength),
      lastReviewDate: Date.now(),
      totalReviews: reviewCount,
      correctStreak: 0,
      taskHistory: [],
      stability: Math.max(0.5, srs.interval / (24 * 60)),
      difficulty: 5,
    };
  }

  /**
   * Ensure SRS data exists with valid format, creating or migrating as needed
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
   * Initialize new SRS data for an item
   */
  static createNew(id: string, type: 'vocab' | 'phrase', difficulty: number = 5): SRSData {
    return {
      id,
      type,
      nextReview: Date.now(),
      interval: 0,
      easeFactor: 2.5,
      history: [],
      
      // Memory strength system
      memoryStrength: 0, // Starts at 0 - completely new
      lastReviewDate: Date.now(),
      totalReviews: 0,
      correctStreak: 0,
      
      taskHistory: [],
      
      // Forgetting curve
      stability: 0.5, // New items start with half-day stability
      difficulty, // 0 (easy) to 10 (hard)
    };
  }

  /**
   * Calculate next review based on current memory strength and stability
   * Uses forgetting curve: R = e^(-t/S) where R is retention, t is time, S is stability
   */
  static calculateNextReview(srs: SRSData): number {
    const { memoryStrength, stability, difficulty } = srs;
    
    // Target retention probability (we want to review when retention drops to ~85%)
    const targetRetention = 0.85;
    
    // Calculate time until target retention based on stability
    // Higher stability = longer intervals
    // Higher difficulty = shorter intervals
    const difficultyFactor = 1 - (difficulty / 20); // 0.5 to 1.0
    const strengthFactor = memoryStrength / 100; // 0 to 1.0
    
    // Base interval in days
    let intervalDays = stability * Math.log(1 / targetRetention) * difficultyFactor;
    
    // Boost interval based on strength
    if (memoryStrength >= 80) {
      intervalDays *= 2.5; // Very strong memories
    } else if (memoryStrength >= 60) {
      intervalDays *= 1.8;
    } else if (memoryStrength >= 40) {
      intervalDays *= 1.3;
    } else if (memoryStrength >= 20) {
      intervalDays *= 0.8;
    } else {
      intervalDays *= 0.4; // Weak memories need frequent review
    }
    
    // Minimum 1 minute, maximum 180 days
    intervalDays = Math.max(0.0007, Math.min(180, intervalDays)); // 0.0007 days ≈ 1 min
    
    const intervalMinutes = intervalDays * 24 * 60;
    return Math.round(intervalMinutes);
  }

  /**
   * Update SRS data after a review
   */
  static updateAfterReview(
    srs: SRSData,
    quality: number, // 0-5
    taskType: TaskType,
    responseTime: number
  ): SRSData {
    const now = Date.now();
    const timeSinceLastReview = now - srs.lastReviewDate;
    const daysSinceReview = timeSinceLastReview / (1000 * 60 * 60 * 24);
    
    // 1. Calculate time decay
    const decayedStrength = this.calculateDecay(srs.memoryStrength, daysSinceReview, srs.stability);
    
    // 2. Apply quality impact with task weight
    const taskWeight = TASK_WEIGHTS[taskType];
    const baseImpact = QUALITY_IMPACT[quality] || 0;
    const weightedImpact = baseImpact * taskWeight;
    
    // 3. Calculate new memory strength
    let newStrength = decayedStrength + weightedImpact;
    
    // Response time bonus/penalty (faster = better retention)
    const speedBonus = this.calculateSpeedBonus(responseTime, taskType);
    newStrength += speedBonus;
    
    // Clamp to 0-100
    newStrength = Math.max(0, Math.min(100, newStrength));
    
    // 4. Update stability based on performance
    let newStability = this.updateStability(srs.stability, quality, srs.correctStreak);
    
    // 5. Update difficulty based on performance pattern
    let newDifficulty = this.updateDifficulty(srs.difficulty, quality, srs.totalReviews);
    
    // 6. Update streaks
    const newStreak = quality >= 3 ? srs.correctStreak + 1 : 0;
    
    // 7. Legacy history
    const legacyScore = quality >= 3 ? 1 : 0;
    const newHistory = [...srs.history, legacyScore];
    
    // 8. Task performance record
    const taskRecord: TaskPerformance = {
      taskType,
      timestamp: now,
      quality,
      responseTime,
      strength: decayedStrength,
    };
    
    const newTaskHistory = [...srs.taskHistory, taskRecord];
    
    // 9. Update ease factor (SM-2 legacy)
    const newEaseFactor = Math.max(1.3, srs.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    
    // Create updated SRS data
    const updatedSRS: SRSData = {
      ...srs,
      memoryStrength: newStrength,
      lastReviewDate: now,
      totalReviews: srs.totalReviews + 1,
      correctStreak: newStreak,
      taskHistory: newTaskHistory,
      stability: newStability,
      difficulty: newDifficulty,
      history: newHistory,
      easeFactor: newEaseFactor,
    };
    
    // 10. Calculate next review interval
    const nextInterval = this.calculateNextReview(updatedSRS);
    updatedSRS.interval = nextInterval;
    updatedSRS.nextReview = now + (nextInterval * 60 * 1000);
    
    return updatedSRS;
  }

  /**
   * Calculate memory decay over time
   * Uses exponential decay: S(t) = S0 * e^(-t/τ)
   */
  private static calculateDecay(currentStrength: number, daysPassed: number, stability: number): number {
    if (daysPassed <= 0) return currentStrength;
    
    // Decay constant based on stability
    const tau = stability * 2; // Time constant
    const decayFactor = Math.exp(-daysPassed / tau);
    
    return currentStrength * decayFactor;
  }

  /**
   * Calculate bonus/penalty based on response speed
   */
  private static calculateSpeedBonus(responseTime: number, taskType: TaskType): number {
    // Expected response times (ms)
    const expectedTimes: Record<TaskType, number> = {
      recognition: 3000,
      recall: 5000,
      listening: 4000,
      typing: 8000,
      sentence: 10000,
    };
    
    const expected = expectedTimes[taskType];
    const ratio = responseTime / expected;
    
    // Fast responses get a small bonus
    if (ratio < 0.5) return 3;
    if (ratio < 0.8) return 1;
    if (ratio > 2.0) return -2;
    return 0;
  }

  /**
   * Update stability based on review performance
   * Good reviews increase stability (memories last longer)
   */
  private static updateStability(currentStability: number, quality: number, streak: number): number {
    let newStability = currentStability;
    
    if (quality >= 4) {
      // Excellent recall - big stability boost
      newStability *= 1.8;
      // Streak bonus
      if (streak >= 3) newStability *= 1.2;
    } else if (quality === 3) {
      // Good recall - moderate boost
      newStability *= 1.4;
    } else if (quality === 2) {
      // Barely recalled - small boost
      newStability *= 1.1;
    } else {
      // Failed - reset stability
      newStability *= 0.5;
    }
    
    // Cap stability (max ~90 days)
    return Math.min(90, newStability);
  }

  /**
   * Update inherent difficulty based on performance trends
   */
  private static updateDifficulty(currentDifficulty: number, quality: number, totalReviews: number): number {
    // Only adjust after a few reviews
    if (totalReviews < 3) return currentDifficulty;
    
    let adjustment = 0;
    
    if (quality <= 1) {
      // Consistently failing - increase difficulty
      adjustment = 0.3;
    } else if (quality >= 4) {
      // Consistently easy - decrease difficulty
      adjustment = -0.2;
    }
    
    const newDifficulty = currentDifficulty + adjustment;
    return Math.max(0, Math.min(10, newDifficulty));
  }

  /**
   * Get current retention probability based on time since last review
   */
  static getRetentionProbability(srs: SRSData): number {
    const now = Date.now();
    const timeSinceReview = now - srs.lastReviewDate;
    const daysSinceReview = timeSinceReview / (1000 * 60 * 60 * 24);
    
    // Current strength after decay
    const currentStrength = this.calculateDecay(srs.memoryStrength, daysSinceReview, srs.stability);
    
    // Convert strength to probability (0-100 -> 0-1)
    return currentStrength / 100;
  }

  /**
   * Determine which task type to present based on mastery level
   */
  static recommendTaskType(srs: SRSData): TaskType {
    const { memoryStrength, totalReviews } = srs;
    
    // Early stages: easier tasks
    if (totalReviews === 0) return 'recognition';
    if (totalReviews <= 2) return 'recall';
    
    // Based on strength, escalate difficulty
    if (memoryStrength >= 80) {
      // Strong memory - challenge with harder tasks
      const options: TaskType[] = ['typing', 'sentence', 'listening'];
      return options[Math.floor(Math.random() * options.length)];
    } else if (memoryStrength >= 50) {
      // Medium strength
      const options: TaskType[] = ['recall', 'listening', 'typing'];
      return options[Math.floor(Math.random() * options.length)];
    } else {
      // Weak memory - stick to easier tasks
      return Math.random() > 0.5 ? 'recognition' : 'recall';
    }
  }

  /**
   * Calculate mastery level for display
   * Based on memory strength score (0-100) per PRODUCT_SUMMARY.md spec:
   * 0-10: New (Gray)
   * 10-30: Struggling (Orange)
   * 30-50: Learning (Amber)
   * 50-70: Proficient (Blue)
   * 70-85: Mastered (Emerald/Green)
   * 85-100: Grandmaster (Purple)
   */
  static getMasteryLevel(srs: SRSData): { label: string; color: string; percentage: number } {
    const { memoryStrength } = srs;
    
    // Use memory strength directly as per spec
    if (memoryStrength >= 85) {
      return { label: 'Grandmaster', color: 'purple', percentage: memoryStrength };
    } else if (memoryStrength >= 70) {
      return { label: 'Mastered', color: 'emerald', percentage: memoryStrength };
    } else if (memoryStrength >= 50) {
      return { label: 'Proficient', color: 'blue', percentage: memoryStrength };
    } else if (memoryStrength >= 30) {
      return { label: 'Learning', color: 'amber', percentage: memoryStrength };
    } else if (memoryStrength >= 10) {
      return { label: 'Struggling', color: 'orange', percentage: memoryStrength };
    } else {
      return { label: 'New', color: 'slate', percentage: memoryStrength };
    }
  }
}

