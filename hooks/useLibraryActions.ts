import { useCallback, useRef } from 'react';
import { getItemSpelling, getItemTitle, isPhraseItem, isVocabItem, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../types';
import { IMAGE_IDB_MARKER, offloadImages, restoreInlineImages } from '../services/libraryImages';
import { saveOverExisting } from '../services/items';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { log, warn, error as logError } from '../services/logger';
import type { DetailViewState } from './useDetailView';
import type { Library } from './useLibrary';
import type { UndoOfferState } from './useUndoOffer';

/** Saving, deleting, archiving and resetting cards. Each change lands in the library, on this device and on the server. */
export function useLibraryActions(
  { latestItemsRef, updateItems, replaceItem, persistChangedItems }: Pick<Library, 'latestItemsRef' | 'updateItems' | 'replaceItem' | 'persistChangedItems'>,
  { removeFromDetailView, removeItemFromDetailContext, removeSentenceFromDetailContext }: Pick<DetailViewState,
    'removeFromDetailView' | 'removeItemFromDetailContext' | 'removeSentenceFromDetailContext'>,
  { offerUndo }: Pick<UndoOfferState, 'offerUndo'>,
) {
  // Refs for batch import to avoid stale closures
  const handleSaveRef = useRef<(item: StoredItem) => void>(() => {});

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

      // Offload any base64 images to IDB before putting into state
      const imagesToSave: Array<{ id: string; base64: string }> = [];
      let data = item.data;
      if (isVocabItem(item) && (data as VocabCard).imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: canonicalItemId, base64: (data as VocabCard).imageUrl! });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
      }
      if (isPhraseItem(item)) {
        const sr = data as SearchResult;
        if (sr.imageUrl?.startsWith('data:image/')) {
          imagesToSave.push({ id: canonicalItemId, base64: sr.imageUrl });
          data = { ...data, imageUrl: IMAGE_IDB_MARKER } as SearchResult;
        }
        if (sr.vocabs?.length) {
          let vc = false;
          const nv = sr.vocabs.map(v => {
            if (v.imageUrl?.startsWith('data:image/')) {
              imagesToSave.push({ id: v.id, base64: v.imageUrl });
              vc = true;
              return { ...v, imageUrl: IMAGE_IDB_MARKER };
            }
            return v;
          });
          if (vc) data = { ...data, vocabs: nv } as SearchResult;
        }
      }
      if (imagesToSave.length > 0) {
        offloadImages(imagesToSave).catch(error => {
          // The images never reached this device's store. Put them back inline, where the next push
          // carries them to the server, instead of leaving markers that point at nothing.
          logError('Image offload failed; keeping the image inline:', error);
          replaceItem(canonicalItemId, current => restoreInlineImages(current, new Map(imagesToSave.map(image => [image.id, image.base64]))));
        });
      }

      const now = Date.now();
      const itemToSave = {
        ...item,
        data,
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
  }, [updateItems, replaceItem]);

  // Keep batch import refs up to date
  handleSaveRef.current = handleSave;

  // Attach a user-pasted/picked image to a sentence under review. Mirrors the vocab/phrase image path:
  // offload the base64 to IDB (awaited, for instant offline display) + upload to the server, then mark
  // the item's imageUrl and persist it. handleSave's own offload block only covers vocab/phrase, so the
  // offload is done explicitly here and the item is saved with the marker (never raw base64 in state).
  const handleAttachSentenceImage = useCallback(async (item: StoredItem, base64: string) => {
    if (!item?.data?.id || !base64.startsWith('data:image/')) return;
    await offloadImages([{ id: item.data.id, base64 }]);
    // A review or a sync can have replaced the sentence during the upload, so mark the current copy.
    const current = latestItemsRef.current.find(saved => saved.data.id === item.data.id) ?? item;
    if (current.isDeleted) return;
    handleSaveRef.current({ ...current, data: { ...current.data, imageUrl: IMAGE_IDB_MARKER } });
  }, []);

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
    handleSaveRef.current({
      data: sentenceData,
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(sentenceData.id, 'sentence'),
    });
  }, []);

  // Refresh-replace: a real re-run of the AI for an already-saved word replaces its saved card(s).
  // A meaning present in both old and new updates IN PLACE (handleSave matches by word+sense and we pass
  // its existing SRS), so spaced-repetition progress survives the refresh; brand-new meanings are added.
  // Unmatched saved senses remain: model sense coverage varies between calls, so omission is not evidence
  // that a valid stored meaning should be deleted. Called again as illustrations stream in (GlobalSearch).
  const handleRefreshReplace = useCallback((word: string, vocabs: VocabCard[]) => {
    if (!vocabs?.length) return;
    const spelling = word.toLowerCase().trim();
    const oldItems = latestItemsRef.current.filter(i =>
      !i.isDeleted && isVocabItem(i) && getItemSpelling(i) === spelling
    );
    vocabs.forEach(vocab => {
      const match = oldItems.find(o => ((o.data as VocabCard).sense || '') === (vocab.sense || ''));
      if (match) {
        // Update IN PLACE: keep the saved item's id/SRS/savedAt, swap in the fresh content.
        // A refresh replaces the card BEFORE its new image has been generated, then re-saves once the
        // image streams in. Carry the existing image forward when the fresh vocab has none yet, so the
        // word is never left imageless — if the user navigates away (or the image gen fails) mid-refresh
        // it simply keeps its old image instead of losing it.
        const prevImage = (match.data as VocabCard).imageUrl;
        handleSaveRef.current({ ...match, data: { ...vocab, id: match.data.id, imageUrl: vocab.imageUrl ?? prevImage }, srs: match.srs, savedAt: match.savedAt });
      } else {
        handleSaveRef.current({
          data: vocab,
          type: 'vocab',
          savedAt: Date.now(),
          srs: SRSAlgorithm.createNew(vocab.id, 'vocab'),
        });
      }
    });
  }, []);

  // Reset only this sense/item. Different meanings now keep independent FSRS schedules. False when the
  // item isn't in the library.
  const resetSRS = useCallback((id: string): boolean => {
    const target = latestItemsRef.current.find(i => i.data.id === id);
    if (!target) return false;
    const srs = SRSAlgorithm.reset(target.data.id, target.type);
    handleSaveRef.current({ ...target, srs });
    offerUndo('Reset', target, item => item.srs?.lastReviewDate === srs.lastReviewDate && !item.srs.totalReviews
      ? { ...item, srs: target.srs, updatedAt: target.updatedAt }
      : item);
    return true;
  }, [offerUndo]);

  return {
    handleSaveRef, handleSave, handleAttachSentenceImage, handleDelete, handleArchive, handleRemoveVocabFromPhrase, handleUnarchive,
    handleSaveSentence, handleRefreshReplace, resetSRS,
  };
}

export type LibraryActions = ReturnType<typeof useLibraryActions>;
