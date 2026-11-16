import { useCallback } from 'react';
import { getItemTitle, isPhraseItem, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../types';
import { IMAGE_IDB_MARKER, attachImage, extractInlineImages, offloadImages, restoreInlineImages, unsavedImages } from '../services/libraryImages';
import { findSavedCopyIndex, makeSentenceStoredItem, patchLiveCopy, saveOverExisting } from '../services/items';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { planReset, unarchiveUndo } from '../services/undoRules';
import { log, logError, warn } from '../services/logger';
import type { DetailViewState } from './useDetailView';
import type { Library } from './useLibrary';
import type { UndoOfferState } from './useUndoOffer';

/** Saving, deleting, archiving and resetting cards. Each change lands in the library, on this device and on the server. */
export function useLibraryActions(
  { userId, latestItemsRef, updateItems, replaceItem, persistChangedItems }:
    Pick<Library, 'userId' | 'latestItemsRef' | 'updateItems' | 'replaceItem' | 'persistChangedItems'>,
  { removeFromDetailView, removeItemFromDetailContext, removeSentenceFromDetailContext }: Pick<DetailViewState,
    'removeFromDetailView' | 'removeItemFromDetailContext' | 'removeSentenceFromDetailContext'>,
  { offerUndo, offerUndoChange }: Pick<UndoOfferState, 'offerUndo' | 'offerUndoChange'>,
) {
  /** Saves `item` over its saved copy, or as a new card. Returns the id it's saved under, or undefined when it isn't saved. */
  const handleSave = useCallback((item: StoredItem): string | undefined => {
    try {
      if (!item || !item.data || !item.data.id) {
        warn('⭐ handleSave: early return - missing item/data/id', item?.data?.id);
        return undefined;
      }

      const rawTitle = getItemTitle(item);
      const incomingTitle = String(rawTitle || '').toLowerCase().trim();
      if (!incomingTitle) {
        warn('⭐ handleSave: early return - empty title', rawTitle);
        return undefined;
      }
      log('⭐ handleSave: saving', incomingTitle, 'type:', item.type, 'id:', item.data.id);

      // The saved copy of this item (services/items findSavedCopyIndex): the same id, else the same type and
      // spelling and, for a word, the exact sense label, so each meaning of a word keeps its own card. Deleted
      // cards count, so saving one again brings its history back. Resolve it before offloading images: the saved
      // item's stable id is also the image key, so uploading under a transient AI id would orphan the new image
      // when the content is merged into an existing card.
      const canonicalItemId = latestItemsRef.current[findSavedCopyIndex(latestItemsRef.current, item)]?.data.id || item.data.id;

      // Offload any base64 images to IDB before putting into state. Pictures saved nowhere, neither on this
      // device nor on the server, go back inline, where the next push carries them to the server, instead of
      // leaving markers that point at nothing.
      const { item: stripped, images: imagesToSave } = extractInlineImages(item, canonicalItemId);
      if (imagesToSave.length > 0) {
        void offloadImages(imagesToSave, userId)
          .then(offload => unsavedImages(imagesToSave, offload))
          .catch(error => {
            logError('Image offload failed; keeping the image inline:', error);
            return imagesToSave;
          })
          .then(unsaved => {
            if (unsaved.length === 0) return;
            replaceItem(canonicalItemId, current => restoreInlineImages(current, new Map(unsaved.map(image => [image.id, image.base64]))));
          });
      }

      const now = Date.now();
      const itemToSave = {
        ...stripped,
        updatedAt: now,
        savedAt: item.savedAt || now,
        // Cleared flags are absent, as the server echoes them.
        isDeleted: undefined,
      };

      updateItems(items => {
        const existingIndex = findSavedCopyIndex(items, item);
        if (existingIndex < 0) {
          // Each meaning owns its own FSRS card. A newly saved sense must not inherit another
          // sense's difficulty, lapses, or due date just because the spelling matches.
          const normalizedSRS = SRSAlgorithm.ensure(itemToSave.srs, itemToSave.data.id, itemToSave.type);
          return [{ ...itemToSave, srs: normalizedSRS, savedAt: now, updatedAt: now }, ...items];
        }

        const next = items.slice();
        next[existingIndex] = saveOverExisting(items[existingIndex], itemToSave, now);
        return next;
      });
      return canonicalItemId;
    } catch (err) {
      logError("Error during save operation:", err);
      return undefined;
    }
  }, [latestItemsRef, updateItems, replaceItem, userId]);

  // Attach a user-pasted/picked image to a sentence under review. Mirrors the vocab/phrase image path:
  // offload the base64 to IDB (awaited, for instant offline display) + upload to the server, then mark
  // the item's imageUrl and persist it. handleSave's own offload block only covers vocab/phrase, so the
  // offload is done explicitly here and the item is saved with the marker (never raw base64 in state).
  // A picture saved nowhere (not stored here, and its upload failed) rejects instead, which the view
  // reports, and the sentence keeps the picture it had.
  const handleAttachSentenceImage = useCallback(async (item: StoredItem, base64: string) => {
    if (!item?.data?.id || !base64.startsWith('data:image/')) return;
    await attachImage(item.data.id, base64, userId);
    // A review or a sync can have replaced the sentence during the upload, so mark the current copy.
    const current = latestItemsRef.current.find(saved => saved.data.id === item.data.id) ?? item;
    if (current.isDeleted) return;
    handleSave({ ...current, data: { ...current.data, imageUrl: IMAGE_IDB_MARKER } });
  }, [latestItemsRef, handleSave, userId]);

  const handleDelete = useCallback(async (id: string) => {
    log('🗑️ App: Deleting item', id);
    const before = latestItemsRef.current.find(item => item.data.id === id);
    const deleted = replaceItem(id, item => ({ ...item, isDeleted: true, updatedAt: Date.now() }));
    if (!deleted) warn('🗑️ App: Item not found for deletion:', id);

    // Update carousel immediately so card disappears instantly. Call both removers — each is a
    // no-op for the other mode (word id vs sentence id), so handleDelete stays mode-agnostic.
    const view = removeFromDetailView(() => {
      removeItemFromDetailContext(id);
      removeSentenceFromDetailContext(id);
    });

    if (!deleted || !before) return;
    if (!before.isDeleted) {
      offerUndo('Deleted', before, item => item.isDeleted ? { ...item, isDeleted: undefined, updatedAt: before.updatedAt } : item, view);
    }
    // Store the deletion now; it's pushed when the undo offer closes.
    await persistChangedItems([deleted], 'Delete');
  }, [
    latestItemsRef, replaceItem, removeFromDetailView, removeItemFromDetailContext, removeSentenceFromDetailContext,
    persistChangedItems, offerUndo,
  ]);

  const handleArchive = useCallback(async (id: string) => {
    log('📦 App: Archiving item', id);
    const before = latestItemsRef.current.find(item => item.data.id === id);
    const archived = replaceItem(id, item => ({ ...item, isArchived: true, updatedAt: Date.now() }));
    if (!archived) warn('📦 App: Item not found for archiving:', id);

    // Update the carousel immediately, before the server sync finishes.
    const view = removeFromDetailView(() => removeItemFromDetailContext(id));

    if (!archived || !before) return;
    if (!before.isArchived) {
      offerUndo('Archived', before, item => item.isArchived ? { ...item, isArchived: undefined, updatedAt: before.updatedAt } : item, view);
    }
    await persistChangedItems([archived], 'Archive');
  }, [latestItemsRef, replaceItem, removeFromDetailView, removeItemFromDetailContext, persistChangedItems, offerUndo]);

  // The server keeps no earlier versions of a phrase, so a removed vocab can't be had back from it. Like a delete, the
  // removal can be taken back for a few seconds instead, and stays on this device meanwhile.
  const handleRemoveVocabFromPhrase = useCallback(async (phraseId: string, vocabId: string) => {
    log('🗑️ App: Removing vocab', vocabId, 'from phrase', phraseId);
    // A phrase keeps at least one vocab.
    const phrase = latestItemsRef.current.find(i => i.data.id === phraseId);
    const vocabs = phrase && isPhraseItem(phrase) ? phrase.data.vocabs : undefined;
    if (!phrase || !Array.isArray(vocabs) || vocabs.length <= 1) return;
    const index = vocabs.findIndex(v => v.id === vocabId);
    if (index < 0) return;
    const removed = vocabs[index];
    const { updatedAt } = phrase;

    const updated = replaceItem(phraseId, item => {
      const phraseData = item.data as SearchResult;
      return {
        ...item,
        data: { ...phraseData, vocabs: (phraseData.vocabs || []).filter(v => v.id !== vocabId) },
        updatedAt: Date.now(),
      };
    });
    if (!updated) return;
    // The offer first, so the phrase is held on this device when the push below runs. Undo puts the vocab back where
    // it was, unless it's back already.
    offerUndoChange({
      ids: [phraseId],
      message: `Removed “${removed.word}”`,
      undo: item => {
        if (!isPhraseItem(item)) return item;
        const current = item.data.vocabs || [];
        if (current.some(v => v.id === vocabId)) return item;
        return { ...item, data: { ...item.data, vocabs: [...current.slice(0, index), removed, ...current.slice(index)] }, updatedAt };
      },
    });
    await persistChangedItems([updated], 'Remove vocab');
  }, [latestItemsRef, replaceItem, persistChangedItems, offerUndoChange]);

  const handleUnarchive = useCallback(async (id: string) => {
    log('📦 App: Unarchiving item', id);
    const before = latestItemsRef.current.find(item => item.data.id === id);
    const unarchived = replaceItem(id, item => ({ ...item, isArchived: undefined, updatedAt: Date.now() }));
    if (!unarchived || !before) return;
    // Like an archive, it can be taken back for a few seconds, and stays on this device meanwhile.
    if (before.isArchived) offerUndo('Unarchived', before, unarchiveUndo(before));
    await persistChangedItems([unarchived], 'Unarchive');
  }, [latestItemsRef, replaceItem, persistChangedItems, offerUndo]);

  /**
   * Applies a write the app makes on its own, such as a listen's speech style or an analysis arriving, to the live
   * item `id` (services/items patchLiveCopy), which is then stored and pushed as any saved change is. Unlike a save,
   * it never brings a deleted item back, and a patch with nothing to change (null, or the item itself) changes nothing.
   */
  const patchLiveItem = useCallback((id: string, patch: (item: StoredItem) => StoredItem | null): void => {
    replaceItem(id, item => patchLiveCopy(item, patch, Date.now()));
  }, [replaceItem]);

  // Save a sentence for review, as services/items builds it from the copy the screen holds.
  const handleSaveSentence = useCallback((text: string, sourceWord: string, sourceSense?: string, prepared?: SentenceData) => {
    handleSave(makeSentenceStoredItem(text, sourceWord, sourceSense, prepared));
  }, [handleSave]);

  /**
   * Refresh-replace: a real re-run of the AI for an already-saved word replaces its saved cards. A meaning the word
   * has a card for updates that card in place, keeping its schedule, and a new meaning gets a card of its own
   * (services/refreshReplace, loaded when a refresh lands). Like a delete, the refresh can be taken back for a few
   * seconds, and its cards stay on this device meanwhile. The fresh result shows in the search sheet either way, so
   * should that code fail to load, only the saving is lost, and the error is logged.
   */
  const handleRefreshReplace = useCallback(async (word: string, vocabs: VocabCard[]): Promise<void> => {
    if (!vocabs?.length) return;
    try {
      const { planRefreshReplace, undoRefreshReplace } = await import('../services/refreshReplace');
      const before = latestItemsRef.current;
      const { updates, created } = planRefreshReplace(before, word, vocabs);
      // Updates replace their cards where they are and new cards go first in the result's order, so saving the
      // updates before the new cards leaves the library as saving them in the result's order would.
      const ids = new Set<string>();
      for (const item of [...updates, ...created]) {
        const id = handleSave(item);
        if (id) ids.add(id);
      }
      // Offered in the same task as the saves, which push nothing themselves, so every push finds the cards held.
      if (ids.size > 0) {
        offerUndoChange({ ids: [...ids], message: `Refreshed “${word.trim()}”`, undo: undoRefreshReplace(before, latestItemsRef.current, ids) });
      }
    } catch (error) {
      logError('Refresh: the fresh result was not saved for', word, error);
    }
  }, [latestItemsRef, handleSave, offerUndoChange]);

  // Reset only this sense/item. Different meanings now keep independent FSRS schedules. False when the item isn't
  // in the library, and the caller saves a fresh copy instead; true when handled, which includes leaving a card
  // deleted here or on another device deleted, and changing nothing on one never reviewed (services/undoRules).
  const resetSRS = useCallback((id: string): boolean => {
    const target = latestItemsRef.current.find(i => i.data.id === id);
    const plan = planReset(target);
    if (plan === 'missing') return false;
    if (plan !== 'reset' || !target) return true;
    const srs = SRSAlgorithm.reset(target.data.id, target.type);
    const reset = replaceItem(id, item => ({ ...item, srs, updatedAt: Date.now() }));
    if (!reset) return true;
    // The offer first, so the reset is held on this device when the push below runs.
    offerUndo('Reset', target, item => item.srs?.lastReviewDate === srs.lastReviewDate && !item.srs.totalReviews
      ? { ...item, srs: target.srs, updatedAt: target.updatedAt }
      : item);
    void persistChangedItems([reset], 'Reset');
    return true;
  }, [latestItemsRef, replaceItem, persistChangedItems, offerUndo]);

  return {
    handleSave, handleAttachSentenceImage, handleDelete, handleArchive, handleRemoveVocabFromPhrase, handleUnarchive,
    patchLiveItem, handleSaveSentence, handleRefreshReplace, resetSRS,
  };
}

export type LibraryActions = ReturnType<typeof useLibraryActions>;
