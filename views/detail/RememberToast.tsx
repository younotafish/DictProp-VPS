import React from 'react';
import { Sparkles } from 'lucide-react';
import { formatNextReview } from './detailUtils';

/** The "Remembered!" confirmation after a review, with when the card comes back if that's known. */
export const RememberToast: React.FC<{ intervalDays: number | null }> = ({ intervalDays }) => (
  <div className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-none">
    <div className="bg-white px-6 py-4 rounded-2xl shadow-2xl flex flex-col items-center gap-1 fade-in">
      <div className="flex items-center gap-3">
        <Sparkles className="text-amber-500 w-6 h-6 animate-pulse" />
        <span className="text-slate-800 font-bold text-lg">Remembered!</span>
      </div>
      {intervalDays !== null && (
        <span className="text-sm text-slate-500">
          Next review {formatNextReview(intervalDays)}
        </span>
      )}
    </div>
  </div>
);
