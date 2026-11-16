import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isVocabItem, savedVocabKey, type ReviewRating, type SRSData, type StoredItem, type VocabCard } from '../../types';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { findSavedCopy, makeVocabStoredItem } from '../../services/items';
import { updateAfterRating } from '../../services/fsrsScheduler';
import { log, warn } from '../../services/logger';
import { acceptDestructive } from '../../services/actionGuards';
import { isTypingTarget } from '../../components/keyboardTarget';
import type { DetailViewProps } from './types';

interface WordActionsOptions {
  /** The card on screen. */
  data: StoredItem['data'];
  type: StoredItem['type'];
  title: string;
  /** The card's saved copy (findSavedCopy), if it's in the library. */
  savedItemMatch: StoredItem | undefined;
  isSaved: boolean;
  savedItemsRef: RefObject<StoredItem[]>;
  /** Whether a word and sense is in the notebook: what a phrase's key-vocab bookmark shows. */
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onResetSRS?: DetailViewProps['onResetSRS'];
  onUpdateSRS?: (itemId: string, rating?: ReviewRating, context?: { seedItem?: StoredItem }) => void | Promise<boolean>;
  setShowActionMenu: Dispatch<SetStateAction<boolean>>;
  /** Whether a remember of the item `id` counts now (useRememberToast): once per item and gesture. */
  tryRemember: (id: string) => boolean;
  /** Confirms a review with the interval it scheduled, for the card on screen, `id`. */
  showRemembered: (next: SRSData, now: number, id: string) => void;
}

/** Whether `now` falls within acceptDestructive's window after a press at `lastAt`, without counting as a press itself. */
const withinDestructiveWindow = (lastAt: number, now: number): boolean => !acceptDestructive({ current: lastAt }, now);

/** What the word card does to the library: save, delete, archive and unarchive, reset, remember, and a phrase's key-vocab saves. */
export function useWordActions({
  data, type, title, savedItemMatch, isSaved, savedItemsRef, isVocabSaved, onSave, onDelete, onArchive, onUnarchive,
  onResetSRS, onUpdateSRS, setShowActionMenu, tryRemember, showRemembered,
}: WordActionsOptions) {
  // A phrase's key-vocab cards save and unsave themselves, by the same word-and-sense rule their bookmark shows
  // (a missing sense is the empty one, and only words count). This handler goes to the memoized word cards, so it
  // changes identity only when the notebook's words do.
  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    if (isVocabSaved(vocab)) {
      const key = savedVocabKey(vocab);
      const existingItem = savedItemsRef.current.find(i => !i.isDeleted && isVocabItem(i) && savedVocabKey(i.data) === key);
      if (existingItem) onDelete(existingItem.data.id);
    } else {
      onSave(makeVocabStoredItem(vocab));
    }
  }, [isVocabSaved, onDelete, onSave, savedItemsRef]);

  // Save only ever saves: on a card that's already saved it does nothing (Delete is the trash, D or the menu's).
  const handleSave = useCallback(() => {
    if (isSaved || !data.id) return;
    onSave({
      data: data,
      type: type,
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(data.id, type)
    });
  }, [isSaved, data, type, onSave]);

  // S and Cmd/Ctrl+S save, and do nothing while typing.
  const handleSaveShortcut = useCallback(() => {
    if (isTypingTarget(document.activeElement)) return;
    handleSave();
  }, [handleSave]);

  // One delete, archive or reset per press (acceptDestructive): a double tap on the trash deletes the card on screen,
  // not then the one that slides into its place, and the header, the menu and D, A and Shift+R share the one guard.
  const lastDestructiveAtRef = useRef(-Infinity);
  // Unarchive keeps the card on screen and puts Got it in its place in the header, beside the trash, so a double press
  // on it would go on to review or delete the card. An Unarchive starts the guard's window, and Got it waits it out too.
  const lastUnarchiveAtRef = useRef(-Infinity);

  const handleDeleteItem = () => {
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToDelete = savedItemMatch?.data.id || data.id;
    if (!idToDelete) {
      warn('Delete failed: No valid ID found');
      return;
    }
    if (!acceptDestructive(lastDestructiveAtRef, performance.now())) return;

    log('🗑️ DetailView: Deleting item:', idToDelete, title);
    setShowActionMenu(false);

    // App.tsx handles updating detailContext and navigation
    onDelete(idToDelete);
  };

  const handleArchiveItem = () => {
    if (!onArchive) return;
    
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToArchive = savedItemMatch?.data.id || data.id;
    if (!idToArchive) {
      warn('Archive failed: No valid ID found');
      return;
    }
    if (!acceptDestructive(lastDestructiveAtRef, performance.now())) return;
    
    log('📦 DetailView: Archiving item:', idToArchive, title);
    setShowActionMenu(false);
    
    // App.tsx handles updating detailContext and navigation
    onArchive(idToArchive);
  };

  const handleUnarchiveItem = () => {
    if (!onUnarchive || !savedItemMatch?.isArchived) return;
    const now = performance.now();
    lastUnarchiveAtRef.current = now;
    lastDestructiveAtRef.current = now;
    setShowActionMenu(false);
    onUnarchive(savedItemMatch.data.id);
  };

  const handleResetSRS = useCallback(() => {
    // Reset only the current sense. Cards with the same spelling learn independently.
    if (!data.id || !acceptDestructive(lastDestructiveAtRef, performance.now())) return;

    log('🔄 DetailView: Resetting SRS for item:', data.id, title);

    // savedItemsRef holds the live library only, so a deleted copy is never the target.
    const target = findSavedCopy(savedItemsRef.current, { type, data });

    if (target) {
      if (!onResetSRS?.(target.data.id)) onSave({ ...target, srs: SRSAlgorithm.reset(target.data.id, target.type) });
    } else {
      // The save list can lag briefly after opening a freshly generated result.
      onSave({
        data,
        type,
        savedAt: Date.now(),
        srs: SRSAlgorithm.reset(data.id, type),
      });
    }

    setShowActionMenu(false);
  }, [data, title, type, onSave, onResetSRS, savedItemsRef, setShowActionMenu]);

  const handleRemember = useCallback(() => {
    const saved = findSavedCopy(savedItemsRef.current, { type, data });
    // An archived card's header offers Unarchive instead of Got it, so R and the double tap or click review nothing,
    // and just after an Unarchive a Got it is the double press's second press.
    if (saved?.isArchived || withinDestructiveWindow(lastUnarchiveAtRef.current, performance.now())) return;
    // One gesture reviews a card once: the same card's second remember within 1.5 s is dropped, while the next card's
    // counts at once.
    const id = saved?.data.id ?? data.id;
    if (!id || !tryRemember(id)) return;

    log('🧠 DetailView: Marking as remembered via shortcut/gesture');

    const now = Date.now();
    if (saved) {
      // Compute preview SRS to show next review date in the animation
      const previewSRS = updateAfterRating(SRSAlgorithm.ensure(saved.srs, saved.data.id, saved.type), 'good', now);
      showRemembered(previewSRS, now, data.id);

      if (onUpdateSRS) {
        log('🧠 DetailView: applying FSRS review to this sense');
        onUpdateSRS(saved.data.id);
      } else {
        log('🧠 DetailView: Using onSave fallback for SRS update');
        onSave({ ...saved, srs: { ...previewSRS, id: saved.data.id } });
      }
    } else {
      // Create new item and immediately mark as remembered
      const newSRS = updateAfterRating(SRSAlgorithm.createNew(data.id, type), 'good', now);
      showRemembered(newSRS, now, data.id);

      onSave({
        data: data,
        type: type,
        savedAt: now,
        srs: newSRS
      });
    }
  }, [data, type, onSave, onUpdateSRS, savedItemsRef, tryRemember, showRemembered]);

  return {
    handleSaveVocab, handleSave, handleSaveShortcut, handleDeleteItem, handleArchiveItem, handleUnarchiveItem,
    handleResetSRS, handleRemember,
  };
}
