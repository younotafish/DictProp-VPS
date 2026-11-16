import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { warn } from '../../services/logger';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { isCatalogProgressItem } from '../../services/catalogProgressIdentity';
import { hasDetailedSentenceAnalysis, mergePreparedSentence, SENTENCE_PREFETCH_AHEAD } from './detailUtils';
import type { DetailViewProps } from './types';

interface SentenceEnrichmentOptions {
  sentenceItems: StoredItem[];
  /** The sentence under review. */
  sentenceIndex: number;
  savedSentenceItemsRef: RefObject<StoredItem[]>;
  onSaveRef: RefObject<(item: StoredItem) => void>;
  /** Writes an upgrade to a saved sentence's live copy, never to a deleted one (DetailViewProps.onPatchItem). */
  onPatchItemRef: RefObject<DetailViewProps['onPatchItem'] | undefined>;
}

/** How long after a failed fetch the lessons are asked for again; coming back online asks at once. */
const RETRY_AFTER_MS = 15_000;

const withoutId = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
};

/**
 * Sentence review's lessons: the analysis and picture the shared enrichment pool holds for the sentence under
 * review and the five after it, fetched ahead so each opens ready. Prepared lessons show at once; a saved sentence
 * also keeps the richer analysis and the picture link, so other devices get them. preparingSentenceId is the sentence
 * on screen while its analysis loads, and failedSentenceIds the sentences whose last fetch threw: those are asked for
 * again 15 s later, when the device comes back online, or when the review moves.
 */
export function useSentenceEnrichment({
  sentenceItems, sentenceIndex, savedSentenceItemsRef, onSaveRef, onPatchItemRef,
}: SentenceEnrichmentOptions) {
  const [preparedSentenceById, setPreparedSentenceById] = useState<Record<string, StoredItem>>({});
  const [preparingSentenceId, setPreparingSentenceId] = useState<string | null>(null);
  const [failedSentenceIds, setFailedSentenceIds] = useState<ReadonlySet<string>>(() => new Set());
  // Bumped by the retry timer, which runs the preparation again for the sentences in view.
  const [retryRound, setRetryRound] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);
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
        checkedSentenceEnrichmentsRef.current.has(requestKey)) return;
    // The sentence on screen shows its analysis loading, also when a fetch ahead of it already asked for it.
    if (showLoading && !hasDetailedSentenceAnalysis(sourceSentence.analysis)) setPreparingSentenceId(id);
    if (preparationRequestsRef.current.has(requestKey)) return;

    preparationRequestsRef.current.add(requestKey);
    setFailedSentenceIds(current => withoutId(current, id));
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

      // The upgrade, worked out on the copy it lands on: nothing when that copy already has a detailed analysis and
      // a picture link.
      const upgrade = (saved: StoredItem): StoredItem | null => {
        const savedData = saved.data as SentenceData;
        const replaceAnalysis = !hasDetailedSentenceAnalysis(savedData.analysis);
        const nextImageUrl = savedData.imageUrl ?? result.imageUrl;
        if (!replaceAnalysis && nextImageUrl === savedData.imageUrl) return null;
        return {
          ...saved,
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
        };
      };
      // On the library's live copy, so a sentence deleted on another device while the lookup ran stays deleted;
      // without onPatchItem, the copy found above is saved as before.
      const patchItem = onPatchItemRef.current;
      if (patchItem) {
        patchItem(savedMatch.data.id, upgrade);
      } else {
        const upgraded = upgrade(savedMatch);
        if (upgraded) onSaveRef.current(upgraded);
      }
    } catch (error) {
      // A fetch that threw (the network or the server) is not marked checked, so it's asked for again: after a while,
      // on reconnecting, or when the review moves. A reply that found nothing was marked checked above: not a failure.
      warn('Failed to preload sentence enrichment', error);
      setFailedSentenceIds(current => current.has(id) ? current : new Set(current).add(id));
      if (!retryTimerRef.current) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          setRetryRound(round => round + 1);
        }, RETRY_AFTER_MS);
      }
    } finally {
      preparationRequestsRef.current.delete(requestKey);
      // Whichever call showed the loading, it ends with the fetch.
      setPreparingSentenceId(current => current === id ? null : current);
    }
  }, [savedSentenceItemsRef, onSaveRef, onPatchItemRef]);

  useEffect(() => {
    const prepare = () => {
      for (let index = 0; index < sentencePreloadWindow.length; index++) {
        void prepareSentenceEnrichment(sentencePreloadWindow[index], index === 0);
      }
    };
    prepare();
    window.addEventListener('online', prepare);
    return () => window.removeEventListener('online', prepare);
  }, [sentencePreloadWindow, prepareSentenceEnrichment, retryRound]);

  return { preparedSentenceById, preparingSentenceId, failedSentenceIds, sentencePreloadWindow };
}
