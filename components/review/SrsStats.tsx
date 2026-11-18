import React from 'react';
import { Flame } from 'lucide-react';
import type { SRSData } from '../../types';
import { MasteryBadge, masteryText, type MasteryClasses } from '../mastery';
import { formatTimeUntil } from '../../services/reviewTime';

interface SrsStatsProps {
  srs: SRSData | undefined;
  /** From SRSAlgorithm.getMasteryLevel. */
  mastery: { label: string; color: string; percentage: number };
  /** getMasteryColors(mastery.color): the bar's classes, and the badge's in the full layout. */
  colors: MasteryClasses;
  /** The sentence banner and the review popup keep each stat on one line and leave the bar out on phones. */
  compact?: boolean;
  /**
   * On phones, also leave out the review count and the streak: the sentence lesson's row holds Reset, Delete and Got it
   * beside the stats, and on a 390 px phone a streak would push Got it past the screen's edge.
   */
  brief?: boolean;
  /** Shown between the streak and the next review. */
  children?: React.ReactNode;
}

/** A card's memory at a glance: mastery badge and bar, reviews, streak, and when it's due. Lays out in its parent's row. */
export function SrsStats({ srs, mastery, colors, compact = false, brief = false, children }: SrsStatsProps) {
  const nextReview = srs?.nextReview ?? 0;
  const now = Date.now();
  return (
    <>
      {compact ? <MasteryBadge {...mastery} /> : (
        <span className={`${colors.bg} ${colors.text} px-2 py-0.5 rounded-full font-semibold`}>
          {masteryText(mastery)}
        </span>
      )}
      <div className={`${compact ? 'hidden sm:block ' : ''}flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden`}>
        <div className={`h-full ${colors.bar} transition-all duration-300`} style={{ width: `${mastery.percentage}%` }} />
      </div>
      <span className={`${brief ? 'hidden sm:inline ' : ''}text-slate-400 whitespace-nowrap`}>{srs?.totalReviews ?? 0}×</span>
      {(srs?.correctStreak ?? 0) > 0 && (
        <span className={`text-orange-500 ${brief ? 'hidden sm:flex' : 'flex'} items-center gap-0.5`}><Flame size={12} />{srs?.correctStreak}</span>
      )}
      {children}
      <span className={`text-slate-500${compact ? ' whitespace-nowrap' : ''}`}>
        {nextReview <= now ? 'due' : formatTimeUntil(nextReview, now)}
      </span>
    </>
  );
}
