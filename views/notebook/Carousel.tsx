import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * A carousel's position as dots, one button per meaning. Each button is taller and wider than the dot it draws,
 * so it's easier to hit.
 */
export const CarouselDots: React.FC<{ count: number; index: number; onSelect: (index: number) => void; className?: string }> = ({
  count, index, onSelect, className = 'flex justify-center',
}) => (
  <div className={className}>
    {Array.from({ length: count }, (_, idx) => (
      <button
        key={idx}
        onClick={(e) => { e.stopPropagation(); onSelect(idx); }}
        className="group/dot h-6 px-[3px] flex items-center"
        aria-label={`Meaning ${idx + 1} of ${count}`}
        aria-current={idx === index ? 'true' : undefined}
      >
        <span className={`block w-2 h-2 rounded-full transition-all ${
          idx === index
            ? 'bg-violet-500 w-4'
            : 'bg-slate-300 group-hover/dot:bg-slate-400'
        }`} />
      </button>
    ))}
  </div>
);

/** A carousel's previous or next button, beside the card on wider screens. Each carousel decides when to show it. */
export const CarouselArrow: React.FC<{ direction: 'previous' | 'next'; onClick: () => void }> = ({ direction, onClick }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`absolute ${direction === 'previous' ? '-left-2' : '-right-2'} top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex`}
    aria-label={direction === 'previous' ? 'Previous meaning' : 'Next meaning'}
  >
    {direction === 'previous' ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
  </button>
);
