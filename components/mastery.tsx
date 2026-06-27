import React from 'react';

/**
 * Shared mastery → Tailwind class helpers + badge, used by every review surface (DetailView,
 * CardReviewPopup, SentencesView). Previously each file kept its own byte-identical copy of the
 * color map / bar thresholds, which drifted. `color` comes from SRSAlgorithm.getMasteryLevel().color.
 */
export type MasteryClasses = { bg: string; text: string; bar: string };

const MASTERY_COLORS: Record<string, MasteryClasses> = {
  slate: { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-600', bar: 'bg-orange-400' },
  amber: { bg: 'bg-amber-100', text: 'text-amber-600', bar: 'bg-amber-400' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-600', bar: 'bg-blue-400' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600', bar: 'bg-emerald-400' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-600', bar: 'bg-purple-400' },
};

/** Badge/bar classes for a mastery level color (falls back to slate). */
export const getMasteryColors = (color: string): MasteryClasses => MASTERY_COLORS[color] || MASTERY_COLORS.slate;

/** Threshold bar color from a 0–100 mastery percentage (used by the Sentences list strip). */
export const barColorFor = (percentage?: number | null): string =>
  percentage == null ? 'bg-slate-300'
    : percentage >= 70 ? 'bg-emerald-400'
    : percentage >= 40 ? 'bg-amber-400'
    : 'bg-red-400';

/** The "Label NN%" pill shown in review headers. Pass the object from SRSAlgorithm.getMasteryLevel(). */
export const MasteryBadge: React.FC<{ label: string; color: string; percentage: number; className?: string }> = ({
  label,
  color,
  percentage,
  className = '',
}) => {
  const c = getMasteryColors(color);
  return (
    <span className={`${c.bg} ${c.text} px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${className}`}>
      {label} {Math.round(percentage)}%
    </span>
  );
};
