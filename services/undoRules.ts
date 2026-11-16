import type { StoredItem } from '../types';
import { acceptKeyRepeat } from '../components/keyboardTarget';

// The rules for what the undo pill takes back, and for its shortcut, apart from the hooks that apply them so node tests
// can pin them. The app shell loads this module in its first chunk, so it stays small and imports nothing that isn't
// already there.

/** Takes back an unarchive: archives the item again, as it was, unless something archived it meanwhile. */
export const unarchiveUndo = (before: StoredItem) => (item: StoredItem): StoredItem =>
  item.isArchived ? item : { ...item, isArchived: true, updatedAt: before.updatedAt };

/** What isUndoShortcut weighs besides the key itself. */
export interface UndoShortcutContext {
  /** The key went to a text field, whose own undo wins. */
  typing: boolean;
  /** The undo pill is up. */
  undoOpen: boolean;
  /** Shortcuts take ⌘ here rather than Ctrl (isMacKeyboard). */
  isMac: boolean;
  /** A dialog that asks for a decision has the keys. */
  modalOpen: boolean;
}

/**
 * Whether a key press takes back what the undo pill offers: ⌘Z on a Mac and Ctrl+Z elsewhere, without Shift (that's
 * redo) or Alt, pressed rather than held, outside text fields and while no decision dialog is open. The card popup
 * doesn't stop it, since the undo pill floats above the popup.
 */
export function isUndoShortcut(
  event: Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  { typing, undoOpen, isMac, modalOpen }: UndoShortcutContext,
): boolean {
  if (!undoOpen || typing || modalOpen || !acceptKeyRepeat(event)) return false;
  if (event.key.toLowerCase() !== 'z' || event.shiftKey || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

type NavigatorFacts = Pick<Navigator, 'platform'> & { userAgentData?: { platform?: string } };

/**
 * Whether shortcuts take ⌘ here rather than Ctrl: on a Mac, or an iPad presenting itself as one. It answers as
 * services/platform's isMacPlatform does for the shortcut sheet's labels; that module loads with the screens, and the
 * app shell's ⌘Z can't wait for it.
 */
export const isMacKeyboard = (nav: NavigatorFacts | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean =>
  !!nav && (nav.userAgentData?.platform === 'macOS' || !!nav.platform?.includes('Mac'));
