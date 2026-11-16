import type { CatalogProgressIndex } from './catalogProgress';
import { sentenceReviewState } from './sentenceReviewState';

// What the Real Life and Essays Study buttons open, and what they say. A run takes the lines due again first and then
// the lines never reviewed, each in catalog order. That differs on purpose from the Sentences tab's weakest-first
// order: a catalog holds hundreds of lines nobody has reviewed yet, and mixed in with them, the reviews falling due
// would wait behind them and lapse.

/** A Study run over the lines in view. */
export interface CatalogQueue<T> {
  /** The lines the run opens, in order: due reviews, then new lines; or, for practice, every line in view. */
  sentences: readonly T[];
  /** Nothing in view was due or new, so the run practices every line in view. */
  practice: boolean;
  /** How many lines of the run are due reviews and how many are new: both 0 for practice. */
  due: number;
  fresh: number;
}

/** The run over `inScope`, the lines in view in catalog order, by their progress records at `now`. */
export function buildCatalogQueue<T extends { id: string }>(
  inScope: readonly T[],
  index: CatalogProgressIndex,
  now: number,
): CatalogQueue<T> {
  const due: T[] = [];
  const fresh: T[] = [];
  for (const sentence of inScope) {
    const state = sentenceReviewState(index.get(sentence.id)?.srs, now);
    if (state === 'due') due.push(sentence);
    else if (state === 'unreviewed') fresh.push(sentence);
  }
  if (due.length === 0 && fresh.length === 0) return { sentences: inScope, practice: true, due: 0, fresh: 0 };
  return { sentences: [...due, ...fresh], practice: false, due: due.length, fresh: fresh.length };
}

/** The Study button's label: 'Study 12', 'Practice' when nothing in view is due or new, 'Study' when nothing is in view. */
export function studyButtonLabel(queue: CatalogQueue<unknown>): string {
  if (queue.sentences.length === 0) return 'Study';
  return queue.practice ? 'Practice' : `Study ${queue.sentences.length}`;
}
