/** What sentence review's bottom row shows, from the sentence's reviews rather than from whether it has a record. */
export interface SentenceRowState {
  /** The sentence's memory on the left, once it has been reviewed: a listen that creates a record shows nothing new. */
  showStats: boolean;
  /** Reset, once there is a review to reset. */
  showReset: boolean;
  /** Delete, for the learner's own saved sentences: never a catalog lesson's line or an unsaved example. */
  showDelete: boolean;
  /**
   * The button at the right end: the compact Got it wherever the sentence can be reviewed, the same size before and
   * after its first review, or Save sentence on an unsaved example opened from a word card.
   */
  primary: 'got-it' | 'save-sentence';
}

/**
 * The bottom row for a sentence: `catalog` for a Real Life or essay line, `preview` while nothing in the library
 * backs it (a catalog line before its first review or listen, or an unsaved example), and its review count.
 */
export function sentenceRowState({ catalog, preview, totalReviews }: {
  catalog: boolean;
  preview: boolean;
  totalReviews: number;
}): SentenceRowState {
  const reviewed = totalReviews > 0;
  const unsavedExample = preview && !catalog;
  return {
    showStats: reviewed,
    showReset: reviewed && !unsavedExample,
    showDelete: !catalog && !preview,
    primary: unsavedExample ? 'save-sentence' : 'got-it',
  };
}
