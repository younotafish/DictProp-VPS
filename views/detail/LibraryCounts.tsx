import React, { useMemo } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import type { StoredItem } from '../../types';

/** The header's library-wide counts. They scan the whole library, so the header renders them only while
 *  it's open, rather than on every card change and review. */
export const LibraryCounts = React.memo(function LibraryCounts({ savedItems }: { savedItems: StoredItem[] }) {
  const { memorizedCount, dueToday } = useMemo(() => {
    const activeItems = savedItems.filter(i => !i.isDeleted && !i.isArchived);
    const memorized = activeItems.filter(i => (i.srs?.memoryStrength ?? 0) >= 70).length;
    const dueSpellings = new Set<string>();
    const now = Date.now();
    activeItems.forEach(i => {
      if ((i.srs?.nextReview ?? 0) <= now) {
        const spelling = (i.type === 'phrase' ? (i.data as any).query : (i.data as any).word || '').toLowerCase().trim();
        if (spelling) dueSpellings.add(spelling);
      }
    });
    return { memorizedCount: memorized, dueToday: dueSpellings.size };
  }, [savedItems]);
  return (
    <>
      <span className="text-slate-300">•</span>
      <span className="text-emerald-600 flex items-center gap-0.5">
        <CheckCircle2 size={12} />
        {memorizedCount}
      </span>
      <span className="text-slate-300">•</span>
      <span className="text-amber-600 flex items-center gap-0.5">
        <Clock size={12} />
        {dueToday}
      </span>
    </>
  );
});
