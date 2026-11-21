// Library items for the tests of Today (services/learningLoop, views/today): saved sentences (and word cards, which
// Today leaves out) with just the fields a test names, and a schedule that is new unless the test gives it reviews.
import type { SentenceAnalysis, SRSData, StoredItem } from '../../types.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

interface ItemOptions {
  savedAt?: number;
  srs?: Partial<SRSData>;
  isArchived?: boolean;
  isDeleted?: boolean;
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
  forms?: string[];
} = {}): StoredItem {
  return {
    type: 'vocab',
    data: {
      id,
      word,
      ...(options.sense !== undefined ? { sense: options.sense } : {}),
      chinese: options.chinese ?? '',
      ipa: '',
      definition: '',
      ...(options.forms ? { forms: options.forms } : {}),
      synonyms: [],
      antonyms: [],
      confusables: [],
      examples: [],
      history: '',
      register: '',
      mnemonic: '',
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
  catalogKind?: 'real-life' | 'essay';
  catalogSentenceId?: string;
  catalogCollectionId?: string;
} = {}): StoredItem {
  const translation = options.translation === undefined ? `译文 ${id}` : options.translation;
  const analysis = translation === null ? undefined : { translation } as SentenceAnalysis;
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
    },
    srs: schedule(id, 'sentence', options.srs),
    savedAt: options.savedAt ?? 0,
    ...flags(options),
  };
}

/** A schedule reviewed at `at` (a Got it, Reviewed, Card review), due again unless the test gives a later nextReview. */
export const reviewed = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: at, fsrsState: 2, ...srs,
});

/** A schedule Got it'd at `at` and resting for the two days a first Got it gives: memorized until then. */
export const memorized = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => reviewed(at, { nextReview: at + 2 * DAY, ...srs });

// The practice membership a v3 build of Today left on a schedule, which the client no longer reads and the server still
// writes for reviews a v3 tab queued (server/src/shared/practice.ts).

/** A schedule in v3's practice: reviewed `totalReviews` times, joined at `since`, last reviewed at `lastReviewDate`. */
export const practicing = (since: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: since, practiceSince: since, practiceChangedAt: since, fsrsState: 1, ...srs,
});

/** A schedule v3 marked one you can say at `at`. */
export const sayable = (at: number, srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 1, lastReviewDate: at, sayableAt: at, practiceChangedAt: at, fsrsState: 2, ...srs,
});
