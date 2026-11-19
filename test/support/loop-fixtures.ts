// Library items for the tests of Today's loop (services/learningLoop): saved sentences (and word cards, which the loop
// leaves out) with just the fields a test names, and a schedule that is new unless the test gives it reviews.
import type { SentenceAnalysis, SRSData, StoredItem } from '../../types.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

interface ItemOptions {
  savedAt?: number;
  srs?: Partial<SRSData>;
  isArchived?: boolean;
  isDeleted?: boolean;
  imageUrl?: string;
}

const schedule = (id: string, type: StoredItem['type'], srs: Partial<SRSData> = {}): SRSData => ({
  id,
  type,
  nextReview: 0,
  interval: 0,
  memoryStrength: 0,
  lastReviewDate: 0,
  totalReviews: 0,
  correctStreak: 0,
  stability: 0.5,
  ...srs,
});

const flags = ({ isArchived, isDeleted }: ItemOptions) => ({
  ...(isArchived ? { isArchived } : {}),
  ...(isDeleted ? { isDeleted } : {}),
});

export function vocabItem(id: string, word: string, options: ItemOptions & {
  sense?: string;
  chinese?: string;
  definition?: string;
  ipa?: string;
  forms?: string[];
  synonyms?: string[];
  examples?: string[];
} = {}): StoredItem {
  return {
    type: 'vocab',
    data: {
      id,
      word,
      ...(options.sense !== undefined ? { sense: options.sense } : {}),
      chinese: options.chinese ?? '',
      ipa: options.ipa ?? '',
      definition: options.definition ?? '',
      ...(options.forms ? { forms: options.forms } : {}),
      synonyms: options.synonyms ?? [],
      antonyms: [],
      confusables: [],
      examples: options.examples ?? [],
      history: '',
      register: '',
      mnemonic: '',
      ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
    },
    srs: schedule(id, 'vocab', options.srs),
    savedAt: options.savedAt ?? 0,
    ...flags(options),
  };
}

export function sentenceItem(id: string, text: string, options: ItemOptions & {
  sourceWord?: string;
  sourceSense?: string;
  /** The analysis's translation; null leaves the sentence without an analysis. */
  translation?: string | null;
  naturalSpeechIpa?: string;
  fastIpa?: string;
  catalogKind?: 'real-life' | 'essay';
  catalogSentenceId?: string;
  catalogCollectionId?: string;
} = {}): StoredItem {
  const translation = options.translation === undefined ? `译文 ${id}` : options.translation;
  const analysis = translation === null ? undefined : {
    translation,
    ...(options.naturalSpeechIpa ? { naturalSpeechIpa: options.naturalSpeechIpa } : {}),
    ...(options.fastIpa ? { pronunciation: { slowIpa: '', fastIpa: options.fastIpa } } : {}),
  } as SentenceAnalysis;
  return {
    type: 'sentence',
    data: {
      id,
      text,
      sourceWord: options.sourceWord ?? '',
      ...(options.sourceSense !== undefined ? { sourceSense: options.sourceSense } : {}),
      ...(analysis ? { analysis } : {}),
      ...(options.catalogKind ? { catalogKind: options.catalogKind } : {}),
      ...(options.catalogSentenceId ? { catalogSentenceId: options.catalogSentenceId } : {}),
      ...(options.catalogCollectionId ? { catalogCollectionId: options.catalogCollectionId } : {}),
      ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
    },
    srs: schedule(id, 'sentence', options.srs),
    savedAt: options.savedAt ?? 0,
    ...flags(options),
  };
}

/** A schedule in practice: reviewed `totalReviews` times, joined at `since`, last reviewed at `lastReviewDate`. */
export const practicing = (since: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: since, practiceSince: since, practiceChangedAt: since, fsrsState: 1, ...srs,
});

/** A schedule marked one you can say at `at`. */
export const sayable = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: at, sayableAt: at, practiceChangedAt: at, fsrsState: 2, ...srs,
});

/** A schedule reviewed the classic way (a Got it, Reviewed, Card review) and never decided in Today: new to the loop. */
export const reviewed = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: at, fsrsState: 2, ...srs,
});

/** A schedule kept passive at `at` by a Meet's Passive (a triage rated good). */
export const passive = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: at, practiceChangedAt: at, fsrsState: 2, ...srs,
});
