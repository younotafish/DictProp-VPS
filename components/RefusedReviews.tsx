import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  dismissRefusedReviews,
  readRefusedReviews,
  subscribeRefusedReviews,
  unseenRefusedReviews,
  type RefusedReviewLog,
} from '../services/reviewQueue';

/** The reviews the server refused for this account, as stored on this device, kept current across tabs. */
export function useRefusedReviews(userId: string | undefined): RefusedReviewLog {
  const [log, setLog] = useState(() => readRefusedReviews(userId ?? ''));
  useEffect(() => {
    const update = () => setLog(readRefusedReviews(userId ?? ''));
    update();
    return subscribeRefusedReviews(update);
  }, [userId]);
  return log;
}

/** Tells of reviews the server refused since this was last dismissed, and offers the list. */
export const RefusedReviewsNotice: React.FC<{ userId: string | undefined; onView: () => void }> = ({ userId, onView }) => {
  const unseen = unseenRefusedReviews(useRefusedReviews(userId));
  if (!userId || unseen === 0) return null;
  return (
    <div role="status" className="pointer-events-auto max-w-[calc(100vw-2rem)] bg-amber-600 text-white rounded-full shadow-xl pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-sm font-medium fade-in">
      <span className="truncate">{unseen === 1 ? '1 review wasn’t accepted' : `${unseen} reviews weren’t accepted`}</span>
      <button onClick={onView} className="shrink-0 rounded-full px-3 py-1 font-semibold hover:bg-white/15">
        View
      </button>
      <button
        onClick={() => dismissRefusedReviews(userId)}
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-amber-100 hover:text-white hover:bg-white/15"
        title="Dismiss"
        aria-label="Dismiss the refused reviews notice"
      >
        <X size={15} />
      </button>
    </div>
  );
};
