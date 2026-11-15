import { BriefcaseBusiness, Crown, Plane, ShoppingBag, UtensilsCrossed } from 'lucide-react';

/** Each Real Life collection's accent: its tile gradient, the soft and active colors of its badges and chips, and its icon. */
export const collectionStyle = {
  indigo: {
    tile: 'from-indigo-600 via-violet-600 to-sky-500',
    soft: 'bg-indigo-50 text-indigo-700',
    active: 'bg-indigo-600 text-white',
    icon: BriefcaseBusiness,
  },
  emerald: {
    tile: 'from-emerald-600 via-teal-600 to-cyan-500',
    soft: 'bg-emerald-50 text-emerald-700',
    active: 'bg-emerald-600 text-white',
    icon: ShoppingBag,
  },
  amber: {
    tile: 'from-amber-600 via-orange-600 to-rose-500',
    soft: 'bg-amber-50 text-amber-800',
    active: 'bg-amber-600 text-white',
    icon: Crown,
  },
  rose: {
    tile: 'from-rose-600 via-red-500 to-orange-500',
    soft: 'bg-rose-50 text-rose-700',
    active: 'bg-rose-600 text-white',
    icon: UtensilsCrossed,
  },
  sky: {
    tile: 'from-sky-600 via-blue-600 to-indigo-500',
    soft: 'bg-sky-50 text-sky-700',
    active: 'bg-sky-600 text-white',
    icon: Plane,
  },
} as const;
