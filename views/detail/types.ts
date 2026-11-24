import type { ItemGroup, ReviewRating, SentenceData, StoredComparison, StoredItem, VocabCard } from '../../types';

export interface DetailViewProps {
  groups?: ItemGroup[];
  initialGroupIndex?: number;
  initialItemIndex?: number;
  /** A new value moves the open view to initialGroupIndex/initialItemIndex, as an undo does when it puts a
   *  removed card back. The first render starts there anyway. */
  navigationKey?: number;

  onClose: () => void;
  onSave: (item: StoredItem) => void;
  /**
   * Applies `patch` to the library's live copy of the item `id`, for the writes the view makes on its own (the voice a
   * listen or a style choice leaves, an analysis or picture that arrives); a deleted item is left alone, so they never
   * bring one back. A null patch writes nothing.
   */
  onPatchItem: (id: string, patch: (item: StoredItem) => StoredItem | null) => void;
  /**
   * Takes an item the library no longer holds, as when another device deleted it, out of the open view. The card or
   * sentence on screen stays; when it's the one taken out, the next takes its place, and the view closes after the last.
   */
  onRemoveFromView: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  /** Returns an archived card to review; the action menu and the A key offer it on archived cards. */
  onUnarchive?: (id: string) => void;
  /** Resets a saved item's progress, with an offer to undo. False when the item isn't in the library. */
  onResetSRS?: (id: string) => boolean;
  savedItems: StoredItem[];
  /** Sentence records are separate from notebook cards; used to resolve catalog progress by exact id. */
  savedSentenceItems?: StoredItem[];
  /** Looks a term up; sentence review passes the sentence it was picked from as `context`, shown above its meanings. */
  onSearch: (text: string, options?: { context?: string }) => void;
  onRefresh?: (text: string) => void; // Force a real AI search, bypassing local cache
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>; // Fetch image from server if missing locally
  onUpdateSRS?: (
    itemId: string,
    rating?: ReviewRating,
    context?: { seedItem?: StoredItem; sessionId?: string },
  ) => void | Promise<boolean>; // Direct SRS update (triggers "remember")
  /**
   * Sentence review opened as one of Today's units: Got it records its review in this session ('set:<unit id>'), so the
   * day's goal and the streak count it. Any other run records none.
   */
  reviewSessionId?: string;
  /** What Back says in sentence review, in place of the one its sentences imply: 'Today' for a unit. */
  sentenceExitLabel?: 'Today';
  /** The signed-in user, whose queue sentence review's study signals go to (useStudySignals); none, none are kept. */
  studyUserId?: string;
  /** The signed-in user, whose Learn later stars the lesson shows and sets (services/learnLater.ts). */
  learnLaterUserId?: string;
  /** Where the run was opened (SentenceRunOptions.studySource), recorded as each study signal's `from`. */
  studySource?: 'sentences' | 'today';
  onCompare?: (words: string[]) => void;
  comparisons?: StoredComparison[];          // saved comparisons (surfaced when they involve this word)
  onOpenComparison?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string, prepared?: SentenceData) => void;
  /** The sentence card an example opens as: its saved copy, or a preview of it. */
  onOpenExampleSentence?: (text: string, word: string, sense?: string) => StoredItem | null;
  isSentenceSaved?: (text: string) => boolean;
  /** Whether a word and sense is in the notebook, looked up in a prebuilt set. */
  isVocabSaved: (vocab: VocabCard) => boolean;
  onRemoveVocabFromPhrase?: (phraseId: string, vocabId: string) => void;
  /** When provided, DetailView enters "sentence mode": aligned 1:1 with `groups`, sentenceItems[i] is
   *  the saved sentence whose source card is groups[i]. Drives the banner, SRS, TTS, autoplay & delete. */
  sentenceItems?: StoredItem[];
  /** Footnote support in the sentence hero: look up a saved item for a term, and open its full card. */
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
  /** True while the card popup owns input — DetailView's keyboard/nav handlers stand down. */
  interactionLocked?: boolean;
  /** Read-only example preview. Analysis/audio remain available; review mutations require saving first. */
  sentencePreviewOnly?: boolean;
  /** Sentence mode: attach a pasted/picked image to a sentence (offloads to IDB + server, marks the item). */
  onAttachImage?: (item: StoredItem, base64: string) => Promise<void> | void;
}

/** What a view gets once DetailView has checked there's a card to show: every group holds at least one card. */
export type DetailViewBodyProps = DetailViewProps & { groups: ItemGroup[] };

/** Sentence review's props: sentenceItems lists the sentences, aligned with the groups of their source cards. */
export type SentenceReviewViewProps = DetailViewBodyProps & {
  sentenceItems: StoredItem[];
  /**
   * What the view follows the sentences by, aligned with sentenceItems: their ids unless given. A word card's example
   * passes one key for the preview's life, since Save sentence swaps the preview for the saved copy, under another id,
   * and the view would take that for the sentence leaving. Reviews, deletes and other writes still use the ids.
   */
  followIds?: readonly string[];
};
