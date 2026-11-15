import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { getItemSense, getItemSpelling, getItemTitle, type ItemGroup, type SentenceData, type StoredItem, type VocabCard } from '../../types';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { stopCurrent } from '../../services/lazyTts';
import { error as logError } from '../../services/logger';
import { isRealLifeProgressItem } from '../../services/realLifeProgressIdentity';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { SENTENCE_PREVIEW_ID_PREFIX } from './sentenceUnderReview';
import type { SavedSentenceIndex } from './useSavedSentenceIndex';
import type { DetailViewProps } from './types';

interface ExampleSentencePreviewOptions {
  onOpenExampleSentence: DetailViewProps['onOpenExampleSentence'];
  savedItemsRef: RefObject<StoredItem[]>;
  savedSentenceIndex: SavedSentenceIndex;
  setIsAutoPlaying: Dispatch<SetStateAction<boolean>>;
  setIsSentenceAutoPlaying: Dispatch<SetStateAction<boolean>>;
}

/**
 * An example sentence opened from the word card, shown as a sentence review over it. It opens at once with the
 * sentence as written and its word as the source card (a saved one when there is one), then takes the prepared
 * copy the caller looks up. Once the sentence is saved, the preview shows the saved copy, with its progress.
 */
export function useExampleSentencePreview({
  onOpenExampleSentence, savedItemsRef, savedSentenceIndex, setIsAutoPlaying, setIsSentenceAutoPlaying,
}: ExampleSentencePreviewOptions) {
  const [exampleSentencePreview, setExampleSentencePreview] = useState<{
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
    const sentence: StoredItem = {
      data: { id: previewId, text, sourceWord: word, sourceSense: sense },
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(previewId, 'sentence'),
    };
    const spelling = word.toLowerCase().trim();
    const candidates = savedItemsRef.current.filter(item =>
      item.type === 'vocab' && getItemSpelling(item) === spelling
    );
    let source = (sense ? candidates.find(item => getItemSense(item) === sense) : undefined) || candidates[0];
    if (!source) {
      const synthetic: VocabCard = {
        id: `sentence-src:${sentence.data.id}`,
        word: word || '(unknown word)',
        sense,
        chinese: '',
        ipa: '',
        definition: '',
        forms: [],
        wordFamily: [],
        synonyms: [],
        antonyms: [],
        confusables: [],
        examples: [text],
        history: '',
        register: '',
        mnemonic: '',
      };
      source = {
        data: synthetic,
        type: 'vocab',
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(synthetic.id, 'vocab'),
      };
    }
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    stopCurrent();
    setExampleSentencePreview({
      sentence,
      sourceGroup: { title: getItemTitle(source), items: [source] },
    });
    void Promise.resolve(onOpenExampleSentence(text, word, sense)).then(hydrated => {
      if (!hydrated || exampleSentenceRequestRef.current !== requestId) return;
      setExampleSentencePreview(current => current ? { ...current, sentence: hydrated } : current);
    }).catch(error => {
      logError('Failed to open prepared example sentence:', error);
    });
  }, [onOpenExampleSentence, savedItemsRef, setIsAutoPlaying, setIsSentenceAutoPlaying]);

  // Closing also drops a lookup still in flight, so it can't reopen the preview.
  const closeExampleSentencePreview = useCallback(() => {
    exampleSentenceRequestRef.current += 1;
    setExampleSentencePreview(null);
  }, []);

  const savedPreviewSentence = exampleSentencePreview
    ? [savedSentenceIndex.byId.get(exampleSentencePreview.sentence.data.id)]
        .concat(savedSentenceIndex.byIdentity.get(
          normalizeSentenceIdentity((exampleSentencePreview.sentence.data as SentenceData).text),
        ) ?? [])
        .find(item => !!item && !isRealLifeProgressItem(item))
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
