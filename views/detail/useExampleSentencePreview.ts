import { useCallback, useRef, useState, type RefObject } from 'react';
import { getItemSense, getItemSpelling, getItemTitle, type ItemGroup, type SentenceData, type StoredItem } from '../../types';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { stopCurrent } from '../../services/neuralTts';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { isCatalogProgressItem } from '../../services/catalogProgressIdentity';
import { syntheticSourceItem } from '../../services/sentenceSource';
import { SENTENCE_PREVIEW_ID_PREFIX } from './sentenceUnderReview';
import type { SavedSentenceIndex } from './useSavedSentenceIndex';
import type { DetailViewProps } from './types';

interface ExampleSentencePreviewOptions {
  onOpenExampleSentence: DetailViewProps['onOpenExampleSentence'];
  savedItemsRef: RefObject<StoredItem[]>;
  savedSentenceIndex: SavedSentenceIndex;
  /** Ends whichever auto-play runs, as the preview opens. */
  stopAutoPlay: () => void;
}

/**
 * An example sentence opened from the word card, shown as a sentence review over it: the caller's sentence card for
 * it (its saved copy, or a preview), with its word as the source card (a saved one when there is one). The review
 * fetches the prepared lesson itself. Once the sentence is saved, the preview shows the saved copy, with its
 * progress, in place.
 */
export function useExampleSentencePreview({
  onOpenExampleSentence, savedItemsRef, savedSentenceIndex, stopAutoPlay,
}: ExampleSentencePreviewOptions) {
  const [exampleSentencePreview, setExampleSentencePreview] = useState<{
    /** Keys the review, so a save or a sync updates it in place and only another example starts a new one. */
    requestId: number;
    sentence: StoredItem;
    sourceGroup: ItemGroup;
  } | null>(null);
  const exampleSentenceRequestRef = useRef(0);

  // This handler goes to the memoized word cards, so it keeps one identity across renders and a card renders
  // again only when something it shows changes.
  const openExampleSentencePreview = useCallback((text: string, word: string, sense?: string) => {
    if (!onOpenExampleSentence) return;
    const requestId = ++exampleSentenceRequestRef.current;
    const previewId = `${SENTENCE_PREVIEW_ID_PREFIX}${crypto.randomUUID()}`;
    const sentence: StoredItem = onOpenExampleSentence(text, word, sense) ?? {
      data: { id: previewId, text, sourceWord: word, sourceSense: sense },
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(previewId, 'sentence'),
    };
    const spelling = word.toLowerCase().trim();
    const candidates = savedItemsRef.current.filter(item =>
      item.type === 'vocab' && getItemSpelling(item) === spelling
    );
    const source = (sense ? candidates.find(item => getItemSense(item) === sense) : undefined) || candidates[0] ||
      syntheticSourceItem(sentence.data.id, word, sense, text);
    stopAutoPlay();
    stopCurrent();
    setExampleSentencePreview({
      requestId,
      sentence,
      sourceGroup: { title: getItemTitle(source), items: [source] },
    });
  }, [onOpenExampleSentence, savedItemsRef, stopAutoPlay]);

  const closeExampleSentencePreview = useCallback(() => setExampleSentencePreview(null), []);

  const savedPreviewSentence = exampleSentencePreview
    ? [savedSentenceIndex.byId.get(exampleSentencePreview.sentence.data.id)]
        .concat(savedSentenceIndex.byIdentity.get(
          normalizeSentenceIdentity((exampleSentencePreview.sentence.data as SentenceData).text),
        ) ?? [])
        .find(item => !!item && !isCatalogProgressItem(item))
    : undefined;
  const previewSentence = exampleSentencePreview
    ? savedPreviewSentence
      ? {
          ...savedPreviewSentence,
          data: {
            ...(exampleSentencePreview.sentence.data as SentenceData),
            ...(savedPreviewSentence.data as SentenceData),
            analysis: (savedPreviewSentence.data as SentenceData).analysis ??
              (exampleSentencePreview.sentence.data as SentenceData).analysis,
            imageUrl: (savedPreviewSentence.data as SentenceData).imageUrl ??
              (exampleSentencePreview.sentence.data as SentenceData).imageUrl,
          },
        }
      : exampleSentencePreview.sentence
    : null;

  return { exampleSentencePreview, savedPreviewSentence, previewSentence, openExampleSentencePreview, closeExampleSentencePreview };
}
