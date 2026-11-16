/**
 * The study session's keys as one pure table: what a key press does, given what the session shows. The view
 * (views/StudyEnhanced.tsx) reads the DOM facts it needs, asks resolveStudyKey, and carries out the action.
 */

import type { ReviewRating } from '../types';
import { RATINGS } from './studySession';

/** What the session shows, and the facts about the key's target that the table needs. */
export interface StudyKeyState {
  /** A card, or the summary once no card is left. */
  phase: 'card' | 'summary';
  /** The card's answer is showing. */
  revealed: boolean;
  /** The last grade can be undone. */
  canUndo: boolean;
  /** An undo of the last grade is under way. */
  undoing: boolean;
  /** The key went to a text field (isTypingTarget), which keeps its keys. */
  typing: boolean;
  /** The keyboard focused a control, which Space and Enter press instead (isKeyboardFocusedControl). */
  onControl: boolean;
  /** A dialog outside the session is open, and has the keys (isDialogOpenOutside). */
  dialogOutside: boolean;
}

export type StudyKeyAction =
  | { type: 'grade'; rating: ReviewRating }
  | { type: 'undo' }
  | { type: 'reveal' }
  /** A key the session owns that does nothing now. It's still stopped, so no other shortcut acts on it. */
  | { type: 'swallow' };

export type StudyKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented'>;

/** Keys 1-4 give the grades in the order of their buttons. */
const RATING_KEYS: ReadonlyMap<string, ReviewRating> = new Map(RATINGS.map((rating, i) => [String(i + 1), rating]));

/**
 * What a key does in a study session, or null when the session leaves it alone. The session owns 1-4 even
 * before the answer shows: an early press does nothing rather than switch tabs mid-session. U undoes the last
 * grade, and Space or Enter shows the answer unless the keyboard focused a control they should press.
 */
export function resolveStudyKey(event: StudyKeyEvent, state: StudyKeyState): StudyKeyAction | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (state.typing || state.dialogOutside) return null;
  const rating = RATING_KEYS.get(event.key);
  if (rating) return state.phase === 'card' && state.revealed ? { type: 'grade', rating } : { type: 'swallow' };
  if (event.key.toLowerCase() === 'u' && state.canUndo && !state.undoing) return { type: 'undo' };
  if ((event.key === ' ' || event.key === 'Enter') && state.phase === 'card' && !state.revealed && !state.onControl) {
    return { type: 'reveal' };
  }
  return null;
}
