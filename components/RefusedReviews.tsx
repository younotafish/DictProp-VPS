import React, { useEffect, useState } from 'react';
import {
  dismissRefusedReviews,
  readRefusedReviews,
  subscribeRefusedReviews,
  unseenRefusedReviews,
  type RefusedReviewLog,
} from '../services/refusedReviews';
import { NoticePill } from './NoticePill';

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
export const RefusedReviewsNotice: React.FC<{ userId: string; onView: () => void }> = ({ userId, onView }) => {
  const unseen = unseenRefusedReviews(useRefusedReviews(userId));
  if (unseen === 0) return null;
  return (
    <NoticePill
      tone="amber"
      actions={[
        { label: 'View', onClick: onView },
        { label: 'Dismiss the refused reviews notice', title: 'Dismiss', dismiss: true, onClick: () => dismissRefusedReviews(userId) },
      ]}
    >
      {unseen === 1 ? '1 review wasn’t accepted' : `${unseen} reviews weren’t accepted`}
    </NoticePill>
  );
};
