/**
 * Checks the views' window-level keyboard shortcuts share: whether a key is being typed or composed, whether
 * it should press the control the keyboard focused, and whether a dialog outside the view has the keys.
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
