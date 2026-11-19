import { getItemTitle, type ReviewRating, type StoredItem } from '../../types';
import { HttpError } from '../../services/http';
import { warn } from '../../services/logger';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { isLoopEligible, itemStanding } from '../../services/learningLoop/standing';
import type { UndoFailure } from '../../services/studySession';

/**
 * The sentence lesson's practice pill as data, apart from React so node tests can pin it: where it shows, what a press
 * records, and what the pill, its undo offer and a failed undo say. A press adds the sentence to Today's practice or
 * takes it out as one you can say. Either is a review, the one a set's Meet records for the same choice, so membership
 * changes only inside a review, here as everywhere (server/src/shared/practice.ts).
 */

/** What the pill shows for the sentence on screen. */
export interface PracticeToggle {
  itemId: string;
  /** The sentence is in Today's practice: the pill is pressed, and a press marks it as one you can say. */
  practicing: boolean;
  /** The sentence as the pill's words quote it: read without its markers, on one line. */
  name: string;
}

/**
 * The pill for `item`, the library's own copy of the sentence on screen, or null where none shows. It shows only on
 * what Today's loop takes (isLoopEligible): one of the learner's own saved sentences, live, with a translation. An
 * example's preview has no library copy, and a word card, a phrase, an archived sentence, a Real Life or essay line and
 * a sentence the Mac hasn't translated yet are out of the loop, where practice would never bring them back.
 */
export function practiceToggleFor(item: StoredItem | undefined): PracticeToggle | null {
  if (!item || !isLoopEligible(item)) return null;
  return {
    itemId: item.data.id,
    practicing: itemStanding(item) === 'practicing',
    name: stripSentenceMarkers(getItemTitle(item)).replace(/\s+/g, ' ').trim(),
  };
}

/** What a press records, with the triage task type, and what its undo offer says. */
export interface PracticeChange {
  rating: ReviewRating;
  /**
   * The undo offer's words: the sentence's new standing, then the sentence. A phone's undo pill has room for about
   * 160 px of text, so it cuts a long sentence short, never what happened to it.
   */
  undoMessage: string;
}

/**
 * Adding is a triage Again and taking out a triage Easy, which marks the sentence one you can say: the ratings of the
 * Meet's Practice and Can say it (services/learningLoop/session.ts MEET_RATINGS, which a test holds these to; the
 * session's module stays out of the card view's code). The caller sends no session id, as Got it sends none, so
 * neither counts toward the day's goal of sentences met in a set.
 */
export function practiceChange({ practicing, name }: PracticeToggle): PracticeChange {
  return practicing
    ? { rating: 'easy', undoMessage: `Can say “${name}”` }
    : { rating: 'again', undoMessage: `Practicing “${name}”` };
}

/** The pill's text: the offer out of practice, the standing in it. Both are as wide, so a press moves nothing. */
export const practicePillText = (practicing: boolean): string => (practicing ? 'Practicing' : '+ Practice');

/**
 * The pill's accessible name: what a press does, including that leaving practice marks the sentence one you can say.
 */
export const practicePillLabel = ({ practicing, name }: PracticeToggle): string =>
  practicing ? `Stop practicing “${name}”: marks it as one you can say` : `Add “${name}” to practice`;

/** How long after a press on a sentence another press on it is ignored: acceptDestructive's window, as for Delete. */
export const PRACTICE_PRESS_WINDOW_MS = 700;

/**
 * Whether a press on the sentence `id` at `now` (any clock in milliseconds that only moves forward) counts, given the
 * last press that did. Only the same sentence within PRACTICE_PRESS_WINDOW_MS is refused, as the second tap of a double
 * tap, which would take it straight back out; another sentence's press always counts. The caller records
 * { id, at: now } as the last press when this says yes.
 */
export function acceptPracticePress(last: { id: string; at: number } | null, id: string, now: number): boolean {
  return !last || last.id !== id || now - last.at >= PRACTICE_PRESS_WINDOW_MS;
}

/**
 * Why taking a press back failed, in words, as Study's undoFailureText says it for a grade but without its advice to
 * try again: the undo offer has closed by then, and the card view offers no other undo. A later change to the sentence
 * superseded the review (409), the device is offline, or the review is still in the outbox.
 */
export function practiceUndoFailureText(failure: UndoFailure, online: boolean): string {
  if (failure !== 'waiting' && failure.error instanceof HttpError && failure.error.status === 409) {
    return 'This sentence has changed since, so the change can’t be undone.';
  }
  if (!online) return 'You’re offline, so the change can’t be undone.';
  return failure === 'waiting'
    ? 'The change is still syncing, so it can’t be undone.'
    : 'The change could not be undone.';
}

/**
 * Takes a press back through `undoReview` (useReviewOutbox's undoSRSReview, which sends the outbox first), resolving
 * to null once it's undone, or to why it couldn't be (practiceUndoFailureText). It never rejects.
 */
export async function undoPracticeChange(
  undoReview: (eventId: string) => Promise<boolean>,
  eventId: string,
  isOnline: () => boolean,
): Promise<string | null> {
  let failure: UndoFailure;
  try {
    if (await undoReview(eventId)) return null;
    failure = 'waiting';
  } catch (error) {
    failure = { error };
  }
  return practiceUndoFailureText(failure, isOnline());
}

/** What a press works with, each read as the press happens. */
export interface PracticePressDeps {
  /** The pill as it shows now; null where it's hidden. */
  toggle: () => PracticeToggle | null;
  /** Records the review (useReviewOutbox's updateSRS). */
  record: (itemId: string, rating: ReviewRating, context: { taskType: 'triage'; eventId: string }) => unknown;
  undoReview: (eventId: string) => Promise<boolean>;
  /** Offers the undo pill (useUndoOffer's offerUndoAction). */
  offerUndo: (message: string, undo: () => void) => void;
  /** Says why an undo failed. */
  showUndoFailure: (message: string) => void;
  now: () => number;
  createId: () => string;
  isOnline: () => boolean;
}

/**
 * The pill's press, which B shares. It records the change's review under a new event id and offers to take back that
 * review by the id, so a later press, or Got it, is never what an undo takes back. Ignored: the same sentence's press
 * within PRACTICE_PRESS_WINDOW_MS; one while that sentence's last press is still being recorded and the pill still
 * shows the standing it was made from (the first review loads the scheduler, which can outlast the window), which would
 * record the same change twice; and one while that sentence's undo is on its way, which would land on top of the review
 * being taken back and so make the server refuse the undo.
 */
export function createPracticePress(deps: PracticePressDeps): () => void {
  let last: { id: string; at: number } | null = null;
  const undoing = new Set<string>();
  // Each sentence whose press is still being recorded, with the standing the press was made from.
  const recording = new Map<string, boolean>();
  return () => {
    const toggle = deps.toggle();
    if (!toggle || undoing.has(toggle.itemId) || recording.get(toggle.itemId) === toggle.practicing) return;
    const now = deps.now();
    if (!acceptPracticePress(last, toggle.itemId, now)) return;
    last = { id: toggle.itemId, at: now };

    const { rating, undoMessage } = practiceChange(toggle);
    const eventId = deps.createId();
    const { itemId, practicing } = toggle;
    recording.set(itemId, practicing);
    const recorded = Promise.resolve(deps.record(itemId, rating, { taskType: 'triage', eventId }))
      .catch(error => warn('Practice change failed:', error))
      .finally(() => { if (recording.get(itemId) === practicing) recording.delete(itemId); });
    // An undo waits for the change to be recorded, so it never asks for an event the outbox doesn't hold yet.
    deps.offerUndo(undoMessage, () => {
      undoing.add(toggle.itemId);
      void recorded.then(() => undoPracticeChange(deps.undoReview, eventId, deps.isOnline)).then(failure => {
        undoing.delete(toggle.itemId);
        if (failure) deps.showUndoFailure(failure);
      });
    });
  };
}
