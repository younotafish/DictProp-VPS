import type { SRSData, StoredItem } from '../types';
import { acceptKeyRepeat } from '../components/keyboardTarget';

// The rules for what the undo pill takes back, and for its shortcut, apart from the hooks that apply them so node tests
// can pin them. The app shell loads this module in its first chunk, so it stays small and imports nothing that isn't
// already there.

/** Whether resetting a schedule changes anything: only a card that has been reviewed has progress to lose. */
export const shouldReset = (srs?: SRSData): boolean => (srs?.totalReviews ?? 0) > 0;

/**
 * What resetting `target`'s schedule does. 'missing': it isn't in the library, so the caller saves a fresh copy (a
 * catalog sentence with no record yet). 'deleted': it was deleted, here or on another device, and stays deleted.
 * 'nothing-to-reset': it has never been reviewed, so nothing changes, and an open undo offer stays open. 'reset': its
 * schedule starts over.
 */
export type ResetPlan = 'missing' | 'deleted' | 'nothing-to-reset' | 'reset';

export const planReset = (target: StoredItem | undefined): ResetPlan => {
  if (!target) return 'missing';
  if (target.isDeleted) return 'deleted';
  return shouldReset(target.srs) ? 'reset' : 'nothing-to-reset';
};

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
