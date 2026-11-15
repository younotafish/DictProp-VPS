import type { RevisionCursor, SRSData, StoredItem } from '../types';
import { getItemContentHash, isItemDirty } from './itemHash';
import { overlayPendingReviews, type PendingReviewMutation } from './reviewQueue';
import { SRSAlgorithm } from './srsAlgorithm';

/** The library as this device stored it, and the server cursor it is current to. */
export interface StoredLibrary {
  items: StoredItem[];
  cursor: RevisionCursor | null;
}

/**
 * Whether a stored schedule predates the current one: no memory strength at all, or a never-reviewed sentence
 * carrying another item type's starting values.
 */
export const needsSrsMigration = (srs: SRSData | undefined, type: StoredItem['type']): boolean =>
  typeof srs?.memoryStrength !== 'number' ||
  (type === 'sentence' && (srs?.totalReviews ?? 0) === 0 &&
    ((srs?.memoryStrength ?? 0) !== 0 || (srs?.stability ?? 0.5) !== 0.5));

/**
 * Brings the library read from this device up to date before it's shown, `now` being the time of the launch:
 * - Records that can't be used (no id, schedule or type) are left out. The server won't resend a left-out
 *   record's changes, so the cursor goes too, and the first sync takes a full snapshot, which brings back
 *   whatever the server has of them.
 * - Old schedules are migrated, records without timestamps get the launch's, and the legacy `project` field
 *   goes: every project merges into the one notebook, with card content and schedules untouched.
 * - A review is written to the outbox synchronously, before its IndexedDB write, so the reviews still queued
 *   there are laid back over the stored copies, and a reload right after a review doesn't roll it back. The
 *   outbox delivers them, so a copy that matched the server stays clean, as after the review itself.
 * Every item none of this changes is returned as it was stored, so saving the result writes only the changes.
 */
export function prepareStoredLibrary(stored: StoredLibrary, pending: readonly PendingReviewMutation[], now: number): StoredLibrary {
  const usable = stored.items.filter(item => item && item.data && item.data.id && item.srs && item.type);
  const cursor = usable.length === stored.items.length ? stored.cursor : null;

  const migrated = usable.map(item => {
    let next = item;
    if (needsSrsMigration(next.srs, next.type)) {
      next = { ...next, srs: SRSAlgorithm.migrate(next.srs) };
    }
    if (!next.updatedAt && !next.savedAt) {
      next = { ...next, savedAt: now, updatedAt: now };
    }
    if (next.project !== undefined) {
      const { project: _legacyProject, ...withoutProject } = next;
      next = withoutProject;
    }
    return next;
  });

  const items = overlayPendingReviews(migrated, pending)
    .map((item, index) => item !== migrated[index] && !isItemDirty(migrated[index])
      ? { ...item, lastSyncedHash: getItemContentHash(item) }
      : item);
  return { items, cursor };
}
