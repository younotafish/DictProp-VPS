import React, { useMemo } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import type { StoredItem } from '../../types';
import { countDueSpellings } from '../../services/studyStats';

/** The header's library-wide counts. They scan the whole library, so the header renders them only while
 *  it's open, rather than on every card change and review. */
export const LibraryCounts = React.memo(function LibraryCounts({ savedItems }: { savedItems: StoredItem[] }) {
  const { memorizedCount, dueCount } = useMemo(() => ({
    memorizedCount: savedItems.filter(i => !i.isDeleted && !i.isArchived && (i.srs?.memoryStrength ?? 0) >= 70).length,
    // Due as the Study dashboard counts it: reviewed before and due now. A never-reviewed card waits with the new ones.
    dueCount: countDueSpellings(savedItems, Date.now()),
  }), [savedItems]);
  const dueLabel = `${dueCount} due (reviewed cards)`;
  return (
    <>
      <span className="text-slate-300">•</span>
      <span className="text-emerald-600 flex items-center gap-0.5">
        <CheckCircle2 size={12} />
        {memorizedCount}
      </span>
      <span className="text-slate-300">•</span>
      <span className="text-amber-600 flex items-center gap-0.5" role="img" aria-label={dueLabel} title={dueLabel}>
        <Clock size={12} />
        {dueCount}
      </span>
    </>
  );
});
