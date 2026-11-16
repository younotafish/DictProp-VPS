import type { StoredItem } from '../types';

// The rules for what the undo pill takes back, and for its shortcut, apart from the hooks that apply them so node tests
// can pin them. The app shell loads this module in its first chunk, so it stays small and imports nothing that isn't
// already there.

/** Takes back an unarchive: archives the item again, as it was, unless something archived it meanwhile. */
export const unarchiveUndo = (before: StoredItem) => (item: StoredItem): StoredItem =>
  item.isArchived ? item : { ...item, isArchived: true, updatedAt: before.updatedAt };
