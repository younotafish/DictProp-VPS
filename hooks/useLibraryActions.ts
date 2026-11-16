import { useCallback } from 'react';
import { getItemSpelling, getItemTitle, isPhraseItem, isVocabItem, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../types';
import { IMAGE_IDB_MARKER, attachImage, extractInlineImages, offloadImages, restoreInlineImages, unsavedImages } from '../services/libraryImages';
import { makeVocabStoredItem, saveOverExisting } from '../services/items';
import { SRSAlgorithm } from '../services/srsAlgorithm';
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
  { offerUndo }: Pick<UndoOfferState, 'offerUndo'>,
) {
  const handleSave = useCallback((item: StoredItem) => {
    try {
      if (!item || !item.data || !item.data.id) {
        warn('⭐ handleSave: early return - missing item/data/id', item?.data?.id);
        return;
      }

      const rawTitle = getItemTitle(item);
      const incomingTitle = String(rawTitle || '').toLowerCase().trim();
      if (!incomingTitle) {
        warn('⭐ handleSave: early return - empty title', rawTitle);
        return;
      }
      log('⭐ handleSave: saving', incomingTitle, 'type:', item.type, 'id:', item.data.id);

      // The saved copy of this item: the same id, else the same title and type, and for vocab the same
      // sense, so each meaning of a word keeps its own card. Resolve it before offloading images: the
      // saved item's stable id is also the image key, so uploading under a transient AI id would
      // orphan the new image when the content is merged into an existing card.
      const incomingSense = isVocabItem(item) ? (item.data.sense || '') : '';
      const findExistingIndex = (items: StoredItem[]): number => {
        const byId = items.findIndex(existing => existing.data.id === item.data.id);
        if (byId >= 0) return byId;
        return items.findIndex(existing => {
          if (existing.type !== item.type || getItemSpelling(existing) !== incomingTitle) return false;
          return !isVocabItem(item) || (isVocabItem(existing) && (existing.data.sense || '') === incomingSense);
        });
      };
      const canonicalItemId = latestItemsRef.current[findExistingIndex(latestItemsRef.current)]?.data.id || item.data.id;

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
        const existingIndex = findExistingIndex(items);
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
    } catch (err) {
      logError("Error during save operation:", err);
    }
  }, [updateItems, replaceItem, userId]);

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
  }, [handleSave, userId]);

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
  }, [replaceItem, persistChangedItems, offerUndo]);

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
  }, [replaceItem, persistChangedItems, offerUndo]);

  const handleRemoveVocabFromPhrase = useCallback(async (phraseId: string, vocabId: string) => {
    log('🗑️ App: Removing vocab', vocabId, 'from phrase', phraseId);
    // A phrase keeps at least one vocab.
    const phrase = latestItemsRef.current.find(i => i.data.id === phraseId);
    const vocabs = phrase && isPhraseItem(phrase) ? phrase.data.vocabs : undefined;
    if (!Array.isArray(vocabs) || vocabs.length <= 1) return;

    const updated = replaceItem(phraseId, item => {
      const phraseData = item.data as SearchResult;
      return {
        ...item,
        data: { ...phraseData, vocabs: (phraseData.vocabs || []).filter(v => v.id !== vocabId) },
        updatedAt: Date.now(),
      };
    });
    if (updated) await persistChangedItems([updated], 'Remove vocab');
  }, [replaceItem, persistChangedItems]);

  const handleUnarchive = useCallback(async (id: string) => {
    log('📦 App: Unarchiving item', id);
    const unarchived = replaceItem(id, item => ({ ...item, isArchived: undefined, updatedAt: Date.now() }));
    if (unarchived) await persistChangedItems([unarchived], 'Unarchive');
  }, [replaceItem, persistChangedItems]);

  // Save sentence for review
  const handleSaveSentence = useCallback((text: string, sourceWord: string, sourceSense?: string, prepared?: SentenceData) => {
    const sentenceData: SentenceData = {
      id: crypto.randomUUID(),
      text,
      sourceWord,
      sourceSense,
      ...(prepared?.preferredSpeechStyle ? { preferredSpeechStyle: prepared.preferredSpeechStyle } : {}),
      ...(prepared?.catalogSentenceId ? { catalogSentenceId: prepared.catalogSentenceId } : {}),
      ...(prepared?.catalogCollectionId ? { catalogCollectionId: prepared.catalogCollectionId } : {}),
      ...(prepared?.catalogKind ? { catalogKind: prepared.catalogKind } : {}),
      ...(prepared?.catalogTitle ? { catalogTitle: prepared.catalogTitle } : {}),
      ...(prepared?.analysis ? { analysis: prepared.analysis } : {}),
      ...(prepared?.analysisGeneratedAt ? { analysisGeneratedAt: prepared.analysisGeneratedAt } : {}),
      ...(prepared?.imageUrl ? { imageUrl: prepared.imageUrl } : {}),
    };
    handleSave({
      data: sentenceData,
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(sentenceData.id, 'sentence'),
    });
  }, [handleSave]);

  // Refresh-replace: a real re-run of the AI for an already-saved word replaces its saved card(s).
  // A meaning present in both old and new updates IN PLACE (handleSave matches by word+sense and we pass
  // its existing SRS), so spaced-repetition progress survives the refresh; brand-new meanings are added.
  // Unmatched saved senses remain: model sense coverage varies between calls, so omission is not evidence
  // that a valid stored meaning should be deleted.
  const handleRefreshReplace = useCallback((word: string, vocabs: VocabCard[]) => {
    if (!vocabs?.length) return;
    const spelling = word.toLowerCase().trim();
    const oldItems = latestItemsRef.current.filter(i =>
      !i.isDeleted && isVocabItem(i) && getItemSpelling(i) === spelling
    );
    vocabs.forEach(vocab => {
      const match = oldItems.find(o => ((o.data as VocabCard).sense || '') === (vocab.sense || ''));
      if (match) {
        // Update IN PLACE: keep the saved item's id/SRS/savedAt, swap in the fresh content. The card keeps
        // its picture unless the fresh analysis brings one, which the search never does: pictures come from
        // the Mac's enrichment cycle.
        const prevImage = (match.data as VocabCard).imageUrl;
        handleSave({ ...match, data: { ...vocab, id: match.data.id, imageUrl: vocab.imageUrl ?? prevImage }, srs: match.srs, savedAt: match.savedAt });
      } else {
        handleSave(makeVocabStoredItem(vocab));
      }
    });
  }, [handleSave]);

  // Reset only this sense/item. Different meanings now keep independent FSRS schedules. False when the
  // item isn't in the library.
  const resetSRS = useCallback((id: string): boolean => {
    const target = latestItemsRef.current.find(i => i.data.id === id);
    if (!target) return false;
    const srs = SRSAlgorithm.reset(target.data.id, target.type);
    handleSave({ ...target, srs });
    offerUndo('Reset', target, item => item.srs?.lastReviewDate === srs.lastReviewDate && !item.srs.totalReviews
      ? { ...item, srs: target.srs, updatedAt: target.updatedAt }
      : item);
    return true;
  }, [handleSave, offerUndo]);

  return {
    handleSave, handleAttachSentenceImage, handleDelete, handleArchive, handleRemoveVocabFromPhrase, handleUnarchive,
    handleSaveSentence, handleRefreshReplace, resetSRS,
  };
}

export type LibraryActions = ReturnType<typeof useLibraryActions>;
