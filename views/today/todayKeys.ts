/**
 * Today's one key as a pure table: Enter on the plan presses the unit card's primary button, Start unit or Continue.
 * views/today/TodayView.tsx listens only while the plan shows and nothing covers the tab, reads the DOM facts the table
 * needs, asks it, and presses the button. All themes' Esc goes through the escape stack; the lesson a unit opens in and
 * Card review keep their own keys.
 */

/** What the plan shows, and the facts about the key's target that the table needs. */
export interface TodayKeyState {
  /** The unit card has a primary button: Start unit, or Continue. */
  hasPrimary: boolean;
  /** The key went to a text field (isTypingTarget), which keeps its keys. */
  typing: boolean;
  /** The keyboard focused a control, which Enter presses instead (isKeyboardFocusedControl). */
  onControl: boolean;
  /** A dialog outside Today is open, and has the keys (isDialogOpenOutside). */
  dialogOutside: boolean;
}

/** Enter on the plan: the unit card's primary button. */
export type TodayKeyAction = { type: 'primary' };

export type TodayKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>;

/**
 * What a key does on the plan, or null when Today leaves it alone: Enter presses the primary button, once per press.
 * Every other key, the number keys that switch tabs among them, and any chord with ⌘, Ctrl or Alt, is the app's.
 */
export function resolveTodayKey(event: TodayKeyEvent, state: TodayKeyState): TodayKeyAction | null {
  if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || state.typing || state.dialogOutside) return null;
  return !event.repeat && event.key === 'Enter' && !state.onControl && state.hasPrimary ? { type: 'primary' } : null;
}
