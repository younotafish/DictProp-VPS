/**
 * The Study tab's keys as pure tables: what a key press does in a session, given what it shows (resolveStudyKey), and
 * on the dashboard between sessions (resolveDashboardKey). The views (views/StudyEnhanced.tsx,
 * components/StudyDashboard.tsx) read the DOM facts the tables need, ask them, and carry out the action.
 */

import type { ReviewRating } from '../types';
import { acceptKeyRepeat } from '../components/keyboardTarget';
import { RATINGS } from './studySession';

/** What the session shows, and the facts about the key's target that the table needs. */
export interface StudyKeyState {
  /** A card, or the summary once no card is left or the session was ended early. */
  phase: 'card' | 'summary';
  /** The card's answer is showing. */
  revealed: boolean;
  /** The card's prompt is its example read aloud (the listening task), which E plays again before the answer shows.
   *  Absent counts as false. */
  listening?: boolean;
  /** The card has an example sentence, which E plays or pauses once the answer shows. Absent counts as false. */
  hasExample?: boolean;
  /** The last grade can be undone. */
  canUndo: boolean;
  /** An undo of the last grade is under way. */
  undoing: boolean;
  /** The summary is of a session ended early with a card left, which R resumes. */
  canResume: boolean;
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
  /** The summary's Done: back to the dashboard. */
  | { type: 'done' }
  /** The summary's Resume: back to the card a session ended early was on. */
  | { type: 'resume' }
  /** P once the answer shows: say the word. */
  | { type: 'speakWord' }
  /** E before the answer shows, on a listening card: play its prompt again from the start. */
  | { type: 'replayPrompt' }
  /** E once the answer shows: play, pause or resume the example, as its speaker does. */
  | { type: 'toggleExample' }
  /** A key the session owns that does nothing now. It's still stopped, so no other shortcut acts on it. */
  | { type: 'swallow' };

export type StudyKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented'>;

/** A key with a modifier, one a view already used, one typed, or one under a dialog outside the Study tab isn't the tab's. */
const isOthersKey = (event: StudyKeyEvent, state: Pick<StudyKeyState, 'typing' | 'dialogOutside'>): boolean =>
  event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || state.typing || state.dialogOutside;

/** Keys 1-4 give the grades in the order of their buttons. */
const RATING_KEYS: ReadonlyMap<string, ReviewRating> = new Map(RATINGS.map((rating, i) => [String(i + 1), rating]));

/**
 * What a key does in a study session, or null when the session leaves it alone. The session owns 1-4 even
 * before the answer shows: an early press does nothing rather than switch tabs mid-session. U undoes the last
 * grade, and Space or Enter shows the answer unless the keyboard focused a control they should press; on the
 * summary Enter is Done, and R resumes a session ended early. On a card P says the word once the answer shows, never
 * before, and E plays a listening card's prompt again before the answer shows and plays or pauses the example after.
 * While an undo is under way, grading, revealing, P and E wait: the undo is about to bring back the card it undoes. A
 * held key acts once, when pressed (acceptKeyRepeat); a held 1-4 stays the session's, so its repeats don't switch tabs.
 */
export function resolveStudyKey(event: StudyKeyEvent, state: StudyKeyState): StudyKeyAction | null {
  if (isOthersKey(event, state)) return null;
  const firstPress = acceptKeyRepeat(event);
  const rating = RATING_KEYS.get(event.key);
  if (rating) {
    return firstPress && state.phase === 'card' && state.revealed && !state.undoing ? { type: 'grade', rating } : { type: 'swallow' };
  }
  if (!firstPress) return null;
  const letter = event.key.toLowerCase();
  if (letter === 'u' && state.canUndo && !state.undoing) return { type: 'undo' };
  if (state.phase === 'card' && !state.undoing) {
    if (letter === 'p') return state.revealed ? { type: 'speakWord' } : null;
    if (letter === 'e') {
      if (!state.revealed) return state.listening ? { type: 'replayPrompt' } : null;
      return state.hasExample ? { type: 'toggleExample' } : null;
    }
  }
  if ((event.key === ' ' || event.key === 'Enter') && state.phase === 'card' && !state.revealed && !state.onControl) {
    return state.undoing ? { type: 'swallow' } : { type: 'reveal' };
  }
  if (event.key === 'Enter' && state.phase === 'summary' && !state.onControl) return { type: 'done' };
  if (letter === 'r' && state.phase === 'summary' && state.canResume) return { type: 'resume' };
  return null;
}

/** What the dashboard between sessions knows when a key is pressed. */
export type DashboardKeyState = Pick<StudyKeyState, 'typing' | 'onControl' | 'dialogOutside'> & {
  /** There is something to review, so Start is live. */
  canStart: boolean;
};

/**
 * What a key does on the Study dashboard: Enter presses Start, once per press, unless the keyboard focused a control
 * Enter should press instead. Every other key, the number keys that switch tabs among them, is left alone.
 */
export function resolveDashboardKey(event: StudyKeyEvent, state: DashboardKeyState): { type: 'start' } | null {
  if (isOthersKey(event, state) || !acceptKeyRepeat(event)) return null;
  return event.key === 'Enter' && state.canStart && !state.onControl ? { type: 'start' } : null;
}
