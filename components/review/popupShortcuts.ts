/**
 * Which review-popup shortcut a key press is, decided apart from the DOM so node tests can pin the table.
 * The popup calls preventDefault exactly when an action comes back, then carries it out.
 *
 * - ← / → page between the word's meanings, when it has more than one.
 * - Space plays or pauses (the first example when nothing is playing); P says the word.
 * - Cmd/Ctrl+1–4 read that example; E reads the first two in turn.
 * - On a saved meaning R is Got it, Shift+R resets and D deletes (after a confirming second press);
 *   on an unsaved one R and Enter save it.
 * - Enter on a saved meaning does nothing ('swallow'), so it can't press a button the mouse clicked (Got it, the
 *   armed delete) a second time; a control the keyboard moved to still takes Space and Enter.
 */
export type PopupAction =
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'togglePlayback' }
  | { type: 'pronounce' }
  | { type: 'readExample'; index: number }
  | { type: 'readBoth' }
  | { type: 'gotIt' }
  | { type: 'reset' }
  | { type: 'save' }
  | { type: 'delete' }
  | { type: 'swallow' };

export type PopupKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey'>;

export interface PopupKeyState {
  /** The key is going into a text field, which keeps it. */
  typing: boolean;
  /** The keyboard moved focus to a control, which Space and Enter should press rather than act as shortcuts. */
  onControl: boolean;
  /** How many meanings the popup pages through. */
  pageCount: number;
  /** The meaning shown is saved, so the review keys apply; otherwise R and Enter save it. */
  saved: boolean;
}

export function resolvePopupShortcut(event: PopupKey, state: PopupKeyState): PopupAction | null {
  if (state.typing) return null;
  const { key } = event;
  if (state.pageCount > 1 && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return { type: key === 'ArrowLeft' ? 'prev' : 'next' };
  }
  if (key === ' ') return state.onControl ? null : { type: 'togglePlayback' };
  if (key === 'p' || key === 'P') return { type: 'pronounce' };
  if ((event.metaKey || event.ctrlKey) && /^[1-4]$/.test(key)) return { type: 'readExample', index: Number(key) - 1 };
  if (key === 'e' || key === 'E') return event.metaKey || event.ctrlKey ? null : { type: 'readBoth' };
  if (key === 'r' || key === 'R') {
    if (!state.saved) return { type: 'save' };
    return { type: event.shiftKey ? 'reset' : 'gotIt' };
  }
  if (key === 'Enter') {
    if (state.onControl) return null;
    return state.saved ? { type: 'swallow' } : { type: 'save' };
  }
  if (key === 'd' || key === 'D') return state.saved && !event.metaKey && !event.ctrlKey ? { type: 'delete' } : null;
  return null;
}
