/**
 * Checks the window-level keyboard shortcuts share: whether a key is being typed or composed, whether a held key
 * acts again, whether it should press the control the keyboard focused, and whether a dialog outside the view has
 * the keys.
 */

/** A key pressed in a text field, select or editable region is typing, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** A key the input method is using mid-composition, such as the Enter that picks a pinyin candidate. */
export function isImeKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

// The keys that act again while held: the arrows, which step through a list or a stack of cards.
const REPEATING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * Whether a key event should act: a first press always does, and a held key's repeats only for an arrow. Any other
 * held key (a letter, Space, Enter) acts once, when pressed, so holding it doesn't fire its shortcut over and over.
 * A shortcut table asks this first and ignores the event when it's false.
 */
export function acceptKeyRepeat(event: Pick<KeyboardEvent, 'repeat' | 'key'>): boolean {
  return !event.repeat || REPEATING_KEYS.has(event.key);
}

// Whether the focused element was focused by a pointer (a click or tap) or by the keyboard, decided the way
// :focus-visible decides it but fixed at focus time, since :focus-visible turns on at the first key press.
let pointerFocused: EventTarget | null = null;
let lastInputWasPointer = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { lastInputWasPointer = true; }, true);
  document.addEventListener('keydown', () => { lastInputWasPointer = false; }, true);
  document.addEventListener('focusin', event => { pointerFocused = lastInputWasPointer ? event.target : null; }, true);
}

const CONTROLS = 'button, a[href], select, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]';

/**
 * Whether Enter or Space on `target` should press the control the keyboard moved focus to. A clicked control
 * keeps focus too, but the keyboard never chose it, so those keys go to the view's shortcut instead.
 */
export function isKeyboardFocusedControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target === pointerFocused) return false;
  return target.closest(CONTROLS) !== null;
}

/** Whether a dialog outside `container` is showing, so the view's shortcuts leave its keys alone. */
export function isDialogOpenOutside(container: Element | null): boolean {
  for (const dialog of document.querySelectorAll('[aria-modal="true"], [role="dialog"]')) {
    if (!container?.contains(dialog) && dialog.getClientRects().length > 0) return true;
  }
  return false;
}
