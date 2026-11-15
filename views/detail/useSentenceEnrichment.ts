import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { warn } from '../../services/logger';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { hasDetailedSentenceAnalysis, mergePreparedSentence, SENTENCE_PREFETCH_AHEAD } from './detailUtils';
import { isCatalogProgressItem } from './useSavedSentenceIndex';

interface SentenceEnrichmentOptions {
  sentenceItems: StoredItem[];
  /** The sentence under review. */
  sentenceIndex: number;
  savedSentenceItemsRef: RefObject<StoredItem[]>;
  onSaveRef: RefObject<(item: StoredItem) => void>;
}

/**
 * Sentence review's lessons: the analysis and picture the shared enrichment pool holds for the sentence under
 * review and the five after it, fetched ahead so each opens ready. Prepared lessons show at once; a saved sentence
 * also keeps the richer analysis and the picture link, so other devices get them.
 */
export function useSentenceEnrichment({ sentenceItems, sentenceIndex, savedSentenceItemsRef, onSaveRef }: SentenceEnrichmentOptions) {
  const [preparedSentenceById, setPreparedSentenceById] = useState<Record<string, StoredItem>>({});
  const [preparingSentenceId, setPreparingSentenceId] = useState<string | null>(null);
  const preparationRequestsRef = useRef(new Set<string>());
  const checkedSentenceEnrichmentsRef = useRef(new Set<string>());

  // Current sentence plus the five immediately ahead. The item JSON is already resident, but catalog
  // enrichment is fetched separately, so warm it before those sentences become visible. This also
  // upgrades saved legacy analyses whenever the shared enrichment pool has a detailed replacement.
  const sentencePreloadWindow = useMemo(() => {
    if (!sentenceItems?.length) return [];
    return sentenceItems
      .slice(sentenceIndex, sentenceIndex + SENTENCE_PREFETCH_AHEAD + 1)
      .map(sentence => mergePreparedSentence(sentence, preparedSentenceById[sentence.data.id]));
  }, [sentenceItems, sentenceIndex, preparedSentenceById]);

  const prepareSentenceEnrichment = useCallback(async (snapshot: StoredItem, showLoading: boolean) => {
    const id = snapshot.data.id;
    const sourceSentence = snapshot.data as SentenceData;
    const requestKey = `${id}:${normalizeSentenceIdentity(sourceSentence.text)}`;
    if ((hasDetailedSentenceAnalysis(sourceSentence.analysis) && sourceSentence.imageUrl) ||
        checkedSentenceEnrichmentsRef.current.has(requestKey) ||
        preparationRequestsRef.current.has(requestKey)) return;

    preparationRequestsRef.current.add(requestKey);
    if (showLoading && !hasDetailedSentenceAnalysis(sourceSentence.analysis)) setPreparingSentenceId(id);
    try {
      const { default: loadPreparedSentenceEnrichment } = await import('../../services/sentenceEnrichment');
      const result = await loadPreparedSentenceEnrichment(sourceSentence.text);
      checkedSentenceEnrichmentsRef.current.add(requestKey);
      if (!result) return;

      const preparedItem: StoredItem = {
        ...snapshot,
        data: {
          ...sourceSentence,
          analysis: result.analysis,
          analysisGeneratedAt: result.analysisGeneratedAt,
          imageUrl: sourceSentence.imageUrl ?? result.imageUrl,
        },
      };
      setPreparedSentenceById(current => ({
        ...current,
        [id]: mergePreparedSentence(current[id] ?? snapshot, preparedItem),
      }));

      // A lookup is read-only for catalog previews, but an already-saved sentence should retain the
      // richer result and its image link across devices. Read the ref after the await to preserve any
      // SRS update that happened while this request was in flight.
      const savedMatch = savedSentenceItemsRef.current.find(candidate => {
        if (candidate.type !== 'sentence' || candidate.isDeleted) return false;
        const candidateData = candidate.data as SentenceData;
        return candidate.data.id === id ||
          (!!sourceSentence.catalogSentenceId &&
            candidateData.catalogSentenceId === sourceSentence.catalogSentenceId &&
            candidateData.catalogCollectionId === sourceSentence.catalogCollectionId) ||
          (!isCatalogProgressItem(candidate) &&
            normalizeSentenceIdentity(candidateData.text) === normalizeSentenceIdentity(sourceSentence.text));
      });
      if (!savedMatch) return;

      const savedData = savedMatch.data as SentenceData;
      const replaceAnalysis = !hasDetailedSentenceAnalysis(savedData.analysis);
      const nextImageUrl = savedData.imageUrl ?? result.imageUrl;
      if (!replaceAnalysis && nextImageUrl === savedData.imageUrl) return;
      onSaveRef.current({
        ...savedMatch,
        data: {
          ...savedData,
          ...(sourceSentence.catalogSentenceId ? { catalogSentenceId: sourceSentence.catalogSentenceId } : {}),
          ...(sourceSentence.catalogCollectionId ? { catalogCollectionId: sourceSentence.catalogCollectionId } : {}),
          ...(sourceSentence.catalogKind ? { catalogKind: sourceSentence.catalogKind } : {}),
          ...(sourceSentence.catalogTitle ? { catalogTitle: sourceSentence.catalogTitle } : {}),
          analysis: replaceAnalysis ? result.analysis : savedData.analysis,
          analysisGeneratedAt: replaceAnalysis ? result.analysisGeneratedAt : savedData.analysisGeneratedAt,
          ...(nextImageUrl ? { imageUrl: nextImageUrl } : {}),
        },
      });
    } catch (error) {
      // Network failures are deliberately not marked checked: moving forward or reconnecting retries.
      warn('Failed to preload sentence enrichment', error);
    } finally {
      preparationRequestsRef.current.delete(requestKey);
      if (showLoading) setPreparingSentenceId(current => current === id ? null : current);
    }
  }, [savedSentenceItemsRef, onSaveRef]);

  useEffect(() => {
    const prepare = () => {
      for (let index = 0; index < sentencePreloadWindow.length; index++) {
        void prepareSentenceEnrichment(sentencePreloadWindow[index], index === 0);
      }
    };
    prepare();
    window.addEventListener('online', prepare);
    return () => window.removeEventListener('online', prepare);
  }, [sentencePreloadWindow, prepareSentenceEnrichment]);

  return { preparedSentenceById, preparingSentenceId, sentencePreloadWindow };
}
