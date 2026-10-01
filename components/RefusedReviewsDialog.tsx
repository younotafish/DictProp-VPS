import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';
import { useRefusedReviews } from './RefusedReviews';
import { clearRefusedReviews, dismissRefusedReviews } from '../services/reviewQueue';

interface Props {
  userId: string;
  onClose: () => void;
}

/** The reviews the server refused, newest first, with Clear all. Render it outside the app's `<main>`. */
export const RefusedReviewsDialog: React.FC<Props> = ({ userId, onClose }) => {
  const { entries } = useRefusedReviews(userId);
  // The list shows every refusal, so the notice about them has done its job, for any arriving meanwhile too.
  const newest = entries[entries.length - 1]?.recordedAt;
  useEffect(() => { dismissRefusedReviews(userId); }, [userId, newest]);
  const newestFirst = entries.slice().reverse();

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" panelClassName="max-h-[85vh] flex flex-col" ariaLabel="Reviews the server refused">
      <div className="p-4 bg-amber-50 border-b border-amber-100 flex justify-between items-center shrink-0">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
          <div className="w-8 h-8 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
            <AlertTriangle size={18} />
          </div>
          Reviews the server refused
        </h3>
        <button
          onClick={onClose}
          aria-label="Close the refused reviews"
          className="w-11 h-11 -m-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-white/50 transition-colors flex items-center justify-center"
        >
          <X size={20} />
        </button>
      </div>
      <p className="px-5 pt-4 text-sm text-slate-600 leading-relaxed shrink-0">
        These reviews aren’t in the server’s review history. Each card keeps its new schedule on this device and
        sends it along with the card.
      </p>
      {newestFirst.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No refused reviews.</p>
      ) : (
        <ul className="flex-1 overflow-y-auto overscroll-contain px-5 py-2 divide-y divide-slate-100">
          {newestFirst.map((entry, index) => (
            <li key={`${entry.recordedAt}:${index}`} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words font-semibold text-slate-800">{entry.word}</span>
                <span className="shrink-0 text-xs text-slate-400">{new Date(entry.reviewedAt).toLocaleString()}</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500 break-words">{entry.reason}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="p-4 border-t border-slate-100 flex gap-3 shrink-0">
        {newestFirst.length > 0 && (
          <Button variant="secondary" onClick={() => clearRefusedReviews(userId)} className="flex-1">
            Clear all
          </Button>
        )}
        <Button variant="primary" onClick={onClose} className="flex-1">
          Close
        </Button>
      </div>
    </Modal>
  );
};
