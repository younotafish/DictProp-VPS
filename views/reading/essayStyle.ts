/** Each essay's accent: its tile gradient, its soft badge colors, and the reader's text-selection color. */
export const essayStyle = {
  indigo: {
    tile: 'from-indigo-950 via-indigo-800 to-blue-600',
    soft: 'bg-indigo-50 text-indigo-700',
    reader: 'selection:bg-indigo-200',
  },
  amber: {
    tile: 'from-stone-950 via-amber-900 to-orange-600',
    soft: 'bg-amber-50 text-amber-800',
    reader: 'selection:bg-amber-200',
  },
  violet: {
    tile: 'from-slate-950 via-violet-900 to-fuchsia-700',
    soft: 'bg-violet-50 text-violet-700',
    reader: 'selection:bg-violet-200',
  },
  rose: {
    tile: 'from-rose-950 via-rose-800 to-orange-500',
    soft: 'bg-rose-50 text-rose-700',
    reader: 'selection:bg-rose-200',
  },
  emerald: {
    tile: 'from-emerald-950 via-emerald-800 to-teal-500',
    soft: 'bg-emerald-50 text-emerald-700',
    reader: 'selection:bg-emerald-200',
  },
} as const;
