import type { ItemGroup, StoredItem } from '../../types';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { SentenceReviewView } from './SentenceReviewView';
import type { DetailViewBodyProps } from './types';

interface ExampleSentencePreviewProps {
  /** The word card's props; the preview shares the library and its callbacks. */
  viewProps: DetailViewBodyProps;
  /** New for each example opened; the review keeps its state while it stays the same. */
  requestId: number;
  sourceGroup: ItemGroup;
  sentence: StoredItem;
  /** A saved copy backs the sentence, so it can be reviewed; otherwise it's read-only until saved. */
  saved: boolean;
  onClose: () => void;
}

/** An example sentence opened from the word card, reviewed over it as a sentence review of its own. */
export function ExampleSentencePreview({ viewProps, requestId, sourceGroup, sentence, saved, onClose }: ExampleSentencePreviewProps) {
  const {
    onSave, onPatchItem, onDelete, onArchive, onUnarchive, onResetSRS, savedItems, savedSentenceItems,
    onSearch, onRefresh,
    onLazyLoadImage, onUpdateSRS, onCompare, comparisons, onOpenComparison, onSaveSentence, isSentenceSaved, isVocabSaved,
    onRemoveVocabFromPhrase, findSaved, onOpenCard, interactionLocked, onAttachImage,
  } = viewProps;
  return (
    <ErrorBoundary
      onReset={onClose}
      fallbackMessage="Something went wrong displaying this sentence. Your word card is still open."
    >
      <SentenceReviewView
        key={`example-sentence:${requestId}`}
        groups={[sourceGroup]}
        initialGroupIndex={0}
        initialItemIndex={0}
        sentenceItems={[sentence]}
        onClose={onClose}
        onSave={onSave}
        onPatchItem={onPatchItem}
        // An example that opened saved and is then deleted on another device closes the preview, as a delete here
        // does (one saved from the preview turns back into the preview). The word card's view never held the
        // sentence, so there is nothing to tell App.
        onRemoveFromView={onClose}
        onDelete={(id) => { onDelete(id); onClose(); }}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onResetSRS={onResetSRS}
        savedItems={savedItems}
        savedSentenceItems={savedSentenceItems}
        onSearch={onSearch}
        onRefresh={onRefresh}
        onLazyLoadImage={onLazyLoadImage}
        onUpdateSRS={onUpdateSRS}
        onCompare={onCompare}
        comparisons={comparisons}
        onOpenComparison={onOpenComparison}
        onSaveSentence={onSaveSentence}
        isSentenceSaved={isSentenceSaved}
        isVocabSaved={isVocabSaved}
        onRemoveVocabFromPhrase={onRemoveVocabFromPhrase}
        findSaved={findSaved}
        onOpenCard={onOpenCard}
        interactionLocked={interactionLocked}
        sentencePreviewOnly={!saved}
        onAttachImage={onAttachImage}
      />
    </ErrorBoundary>
  );
}
