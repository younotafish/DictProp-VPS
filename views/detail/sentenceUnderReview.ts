import type { SentenceData, StoredItem } from '../../types';
import { mergePreparedSentence } from './detailUtils';

/** Word-card example previews carry ids with this prefix until they're saved. */
export const SENTENCE_PREVIEW_ID_PREFIX = 'sentence-preview:';

export interface SentenceUnderReview {
  /** The sentence on screen: the live saved copy when there is one, with any prepared analysis and image merged in. */
  currentSentence: StoredItem | null;
  /** A Real Life or essay sentence, reviewed under its catalog identity. */
  catalogSentencePreview: boolean;
  catalogPreviewKind: 'real-life' | 'essay' | undefined;
  /** Nothing in the library backs it yet, so reviews and deletes need a save first (catalog Got it creates one). */
  isSentencePreview: boolean;
  /** Where Back returns to. */
  sentenceExitLabel: 'Essays' | 'Real Life' | 'Word' | 'Sentences';
}

/**
 * Resolves the sentence a sentence-review view shows from the list's snapshot of it. A catalog sentence binds to
 * its saved progress record, matched by id or by catalog sentence and collection; an unsaved example preview
 * binds to a saved sentence with the same text once there is one (as after Save sentence); anything else is
 * shown as listed. `prepared` is the analysis and image fetched for the snapshot, merged under live data.
 */
export function resolveSentenceUnderReview(
  snapshot: StoredItem | null,
  prepared: StoredItem | undefined,
  savedSentenceItems: readonly StoredItem[],
  findSavedByText: (text: string) => StoredItem | undefined,
  previewOnly: boolean,
): SentenceUnderReview {
  const snapshotData = snapshot?.data as SentenceData | undefined;
  const catalogSentencePreview = !!(snapshot && snapshotData?.catalogSentenceId);
  const catalogPreviewKind = snapshot ? (snapshotData?.catalogKind ?? 'real-life') : undefined;
  const preparedSnapshot = snapshot ? mergePreparedSentence(snapshot, prepared) : null;
  const isPreviewId = !!snapshot && snapshot.data.id.startsWith(SENTENCE_PREVIEW_ID_PREFIX);
  const savedCopy = snapshot
    ? catalogSentencePreview
      ? savedSentenceItems.find(item => item.type === 'sentence' && !item.isDeleted && (
          item.data.id === snapshot.data.id ||
          ((item.data as SentenceData).catalogSentenceId === snapshotData?.catalogSentenceId &&
            (item.data as SentenceData).catalogCollectionId === snapshotData?.catalogCollectionId)
        ))
      : isPreviewId
        ? findSavedByText(snapshotData?.text ?? '')
        : undefined
    : undefined;
  const currentSentence = savedCopy && preparedSnapshot
    ? mergePreparedSentence(savedCopy, preparedSnapshot)
    : preparedSnapshot;
  // A caller's preview, an unsaved catalog sentence, or an example under a preview id.
  const isSentencePreview = !savedCopy && !!snapshot && (previewOnly || catalogSentencePreview || isPreviewId);
  const sentenceExitLabel = catalogSentencePreview
    ? catalogPreviewKind === 'essay' ? 'Essays' : 'Real Life'
    : isSentencePreview
      ? 'Word'
      : 'Sentences';
  return { currentSentence, catalogSentencePreview, catalogPreviewKind, isSentencePreview, sentenceExitLabel };
}
