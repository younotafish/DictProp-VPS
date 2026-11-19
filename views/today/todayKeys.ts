/**
 * Today's keys as a pure table: what a key press does on the plan, on a card of a set or practice session, and on a
 * session's summary, given what the screen shows. views/today/TodayView.tsx reads the DOM facts the table needs, asks
 * it, and carries out the action; the themes browser and Card review have no keys here (Esc goes through the escape
 * stack, and Card review keeps classic Study's own keys).
 */

import type { MeetChoice } from '../../services/learningLoop/session';

/** Which buttons a card's footer shows: the cue's Hint and Reveal, the Meet's three choices, a run's Not yet and Got
 *  it, or one Next (after Practice while it's said twice, and on the last look at a sentence missed twice). */
export type TodayFooter = 'cue' | 'meet' | 'encode' | 'run' | 'look';

/** What Today shows, and the facts about the key's target that the table needs. */
export interface TodayKeyState {
  screen: 'plan' | 'card' | 'summary';
  /** On a card, its footer. */
  footer?: TodayFooter;
  /** On a cue: its hint can still be taken. */
  canHint?: boolean;
  /** In the Meet: Can say it is open (it closes once the hint has shown). */
  sayOpen?: boolean;
  /** The answer showed under 350 ms ago, so Enter isn't Got it yet: the second press of a double press. */
  justRevealed?: boolean;
  /** The last review (in the Meet, the last choice) can be taken back, and whether that is under way. */
  canUndo: boolean;
  undoing: boolean;
  /** On the plan or a summary: its primary button acts. */
  hasPrimary?: boolean;
  /** The summary is of a session ended early, which R takes up again. */
  canResume?: boolean;
  /** The app's undo pill is up: ⌘Z takes back what it offers instead. */
  appUndoOpen: boolean;
  /** Shortcuts take ⌘ here rather than Ctrl. */
  isMac: boolean;
  /** The key went to a text field (isTypingTarget), which keeps its keys. */
  typing: boolean;
  /** The keyboard focused a control, which Space and Enter press instead (isKeyboardFocusedControl). */
  onControl: boolean;
  /** A dialog outside Today is open, and has the keys (isDialogOpenOutside). */
  dialogOutside: boolean;
}

export type TodayKeyAction =
  | { type: 'reveal' }
  | { type: 'hint' }
  | { type: 'choose'; choice: MeetChoice }
  | { type: 'answer'; gotIt: boolean }
  /** Next: on from saying a sentence twice, or from the last look. */
  | { type: 'next' }
  /** P: say the answer again. */
  | { type: 'play' }
  | { type: 'undo' }
  /** Enter on the plan or a summary: its primary button. */
  | { type: 'primary' }
  | { type: 'resume' }
  /** A key a session owns that does nothing now. It's still stopped, so 1-3 never switch tabs mid-session. */
  | { type: 'swallow' };

export type TodayKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>;

const MEET_KEYS: ReadonlyMap<string, MeetChoice> = new Map([
  ['1', 'practice'], ['2', 'passive'], ['3', 'say'],
  ['ArrowLeft', 'practice'], ['ArrowDown', 'passive'], ['ArrowRight', 'say'],
]);
const NUMBER_KEYS = new Set(['1', '2', '3']);

/** Whether the key is ⌘Z on a Mac, or Ctrl+Z elsewhere: undo, not redo (Shift) or another chord. */
const isUndoChord = (event: TodayKeyEvent, isMac: boolean): boolean =>
  event.key.toLowerCase() === 'z' && !event.shiftKey && !event.altKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/**
 * What a key does on Today, or null when Today leaves it alone.
 * - On the plan, Enter presses the primary button; every other key, the number keys that switch tabs among them, is
 *   left alone.
 * - A session owns 1-3 on its cards and summary, so an early or late press does nothing rather than switch tabs. In the
 *   Meet, 1/← is Practice, 2/↓ Passive and 3/→ Can say it, once the answer shows (3 and → do nothing once a hint closed
 *   Can say it); in a run, 1 is Not yet and 3 Got it, and Enter is Got it too, except as the second press of a double
 *   press within 350 ms of the reveal.
 * - Space or Enter shows the answer, and moves on from saying a sentence twice or from the last look; H takes the
 *   hint; P says the answer again; U, or ⌘Z while the app's undo pill isn't up, takes back the last review (Back, in
 *   the Meet). On a summary Enter is its primary button and R resumes a session ended early.
 * - While an undo is under way, answers, choices, the reveal and Next wait: the undo is about to bring back its card.
 * A held key acts once, when pressed; held 1-3 stay the session's, so their repeats don't switch tabs either.
 */
export function resolveTodayKey(event: TodayKeyEvent, state: TodayKeyState): TodayKeyAction | null {
  if (event.defaultPrevented || event.altKey || state.typing || state.dialogOutside) return null;
  // No key of Today's acts again while held, the Meet's arrows included: each acts once, when pressed.
  const firstPress = !event.repeat;
  if (event.metaKey || event.ctrlKey) {
    const undo = firstPress && state.screen !== 'plan' && isUndoChord(event, state.isMac) && !state.appUndoOpen &&
      state.canUndo && !state.undoing;
    return undo ? { type: 'undo' } : null;
  }
  const letter = event.key.toLowerCase();
  const pressing = (event.key === ' ' || event.key === 'Enter') && !state.onControl;

  if (state.screen === 'plan') {
    return firstPress && event.key === 'Enter' && !state.onControl && state.hasPrimary ? { type: 'primary' } : null;
  }

  const footer = state.screen === 'card' ? state.footer : undefined;
  const choice = MEET_KEYS.get(event.key);
  if (footer === 'meet' && choice) {
    if (!firstPress || state.undoing || (choice === 'say' && !state.sayOpen)) return { type: 'swallow' };
    return { type: 'choose', choice };
  }
  if (NUMBER_KEYS.has(event.key)) {
    if (footer === 'run' && firstPress && !state.undoing && event.key !== '2') return { type: 'answer', gotIt: event.key === '3' };
    return { type: 'swallow' };
  }
  if (!firstPress) return null;
  if (letter === 'u' && state.canUndo && !state.undoing) return { type: 'undo' };

  if (state.screen === 'summary') {
    // A session ended early has Resume as its primary button.
    if (event.key === 'Enter' && !state.onControl) {
      return state.canResume ? { type: 'resume' } : state.hasPrimary ? { type: 'primary' } : null;
    }
    return letter === 'r' && state.canResume ? { type: 'resume' } : null;
  }

  const answerShowing = footer !== undefined && footer !== 'cue';
  if (letter === 'h') return footer === 'cue' && state.canHint && !state.undoing ? { type: 'hint' } : null;
  if (letter === 'p') return answerShowing && !state.undoing ? { type: 'play' } : null;
  if (!pressing) return null;
  if (footer === 'cue') return state.undoing ? { type: 'swallow' } : { type: 'reveal' };
  if (footer === 'encode' || footer === 'look') return state.undoing ? { type: 'swallow' } : { type: 'next' };
  if (footer === 'run' && event.key === 'Enter') {
    return state.undoing || state.justRevealed ? { type: 'swallow' } : { type: 'answer', gotIt: true };
  }
  return null;
}
