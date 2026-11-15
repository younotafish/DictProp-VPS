/** The word card's minimal meaning indicator while its header is closed: one dot per meaning, the current one larger. */
export function MeaningDots({ count, index }: { count: number; index: number }) {
  return (
    <div className="sticky top-0 z-20 flex justify-center pt-2 pb-1">
      <div className="flex items-center gap-1">
        {Array.from({ length: count }, (_, idx) => (
          <div
            key={idx}
            className={`rounded-full transition-all duration-200 ${
              idx === index 
                ? 'w-1.5 h-1.5 bg-violet-400' 
                : 'w-1 h-1 bg-slate-300'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
