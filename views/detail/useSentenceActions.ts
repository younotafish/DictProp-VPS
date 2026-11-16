import { useCallback, useRef, type RefObject } from 'react';
import type { ReviewRating, SRSData, StoredItem } from '../../types';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { updateAfterRating } from '../../services/fsrsScheduler';
import { log } from '../../services/logger';
import { acceptDestructive } from '../../services/actionGuards';
import type { DetailViewProps } from './types';

interface SentenceActionsOptions {
  /** The sentence under review, as rendered (Delete) and as last written (Remember and Reset). */
  currentSentence: StoredItem | null;
  currentSentenceRef: RefObject<StoredItem | null>;
  /** Nothing in the library backs the sentence yet; only a catalog sentence can be reviewed that way. */
  isSentencePreview: boolean;
  catalogSentencePreview: boolean;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onResetSRS?: DetailViewProps['onResetSRS'];
  onUpdateSRS?: (itemId: string, rating?: ReviewRating, context?: { seedItem?: StoredItem }) => void | Promise<boolean>;
  /** Whether a remember of the item `id` counts now (useRememberToast): once per item and gesture. */
  tryRemember: (id: string) => boolean;
  /** Confirms a review with the interval it scheduled, for the sentence `id`. */
  showRemembered: (next: SRSData, now: number, id: string) => void;
}

/** Remember, Reset and Delete for the sentence under review. A preview has none of them, except a catalog sentence's Remember. */
export function useSentenceActions({
  currentSentence, currentSentenceRef, isSentencePreview, catalogSentencePreview, onSave, onDelete, onResetSRS,
  onUpdateSRS, tryRemember, showRemembered,
}: SentenceActionsOptions) {
  // One delete or reset per press (acceptDestructive): a doubled Delete or D deletes the sentence on screen, not then
  // the one that slides into its place, and a doubled Shift+R can't make the undo restore a blank schedule.
  const lastDestructiveAtRef = useRef(-Infinity);

  // Delete the SENTENCE (App removes its group + advances/closes the flow).
  const handleDeleteItem = () => {
    if (!currentSentence || isSentencePreview || !acceptDestructive(lastDestructiveAtRef, performance.now())) return;
    log('🗑️ DetailView: Deleting sentence:', currentSentence.data.id);
    onDelete(currentSentence.data.id);
  };

  // Reset just this sentence's SRS.
  const handleResetSRS = useCallback(() => {
    const s = currentSentenceRef.current;
    if (!s || isSentencePreview || !acceptDestructive(lastDestructiveAtRef, performance.now())) return;
    log('🔄 DetailView: Resetting SRS for sentence:', s.data.id);
    // A catalog sentence isn't in the library yet; saving it with fresh progress adds it.
    if (!onResetSRS?.(s.data.id)) onSave({ ...s, srs: SRSAlgorithm.reset(s.data.id, 'sentence') });
  }, [onSave, onResetSRS, isSentencePreview, currentSentenceRef]);

  const handleRemember = useCallback(() => {
    const s = currentSentenceRef.current;
    if ((isSentencePreview && !catalogSentencePreview) || !s) return;
    // A touch double-tap and the dblclick it synthesizes both land, so the same sentence within 1.5 s counts once;
    // the next sentence counts at once.
    if (!tryRemember(s.data.id)) return;
    // Remember THIS sentence (its own SRS) and show the success overlay. The card STAYS put afterwards —
    // same as word-item review — so you can keep looking at it; switch sentences manually (swipe ↑/↓, arrow
    // keys, or the next-sentence gesture) when you're ready. The live SRS refresh means the banner now
    // reflects the bumped step/next-review in place.
    const now = Date.now();
    const previewSRS = updateAfterRating(SRSAlgorithm.ensure(s.srs, s.data.id, 'sentence'), 'good', now);
    onUpdateSRS?.(
      s.data.id,
      'good',
      catalogSentencePreview ? { seedItem: s } : undefined,
    );
    showRemembered(previewSRS, now, s.data.id);
  }, [catalogSentencePreview, onUpdateSRS, isSentencePreview, currentSentenceRef, tryRemember, showRemembered]);

  return { handleDeleteItem, handleResetSRS, handleRemember };
}
