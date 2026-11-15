import type { RevisionCursor, StoredItem } from '../types';

/** Where a full snapshot comes from, and what's done with it. */
export interface SnapshotSync {
  /** The server's whole library, and the cursor after its last change. */
  loadAll: () => Promise<{ items: StoredItem[]; cursor: RevisionCursor }>;
  /** Merges a non-empty snapshot and stores the result with the snapshot's cursor. */
  mergeSnapshot: (items: StoredItem[], cursor: RevisionCursor) => Promise<void>;
  /** Keeps only the cursor, for an empty snapshot. */
  storeCursor: (cursor: RevisionCursor) => void;
}

/**
 * Merges a complete snapshot. An empty server isn't authoritative: merging it would turn the whole library
 * dirty and re-upload it, so only its cursor is kept.
 */
export async function syncSnapshot({ loadAll, mergeSnapshot, storeCursor }: SnapshotSync): Promise<void> {
  const { items, cursor } = await loadAll();
  if (items.length === 0) {
    storeCursor(cursor);
    return;
  }
  await mergeSnapshot(items, cursor);
}

/**
 * Pulls what changed since `cursor`. Without a cursor, or when the pull reports the server behind it (its
 * database was replaced), only a full snapshot can reconcile.
 */
export async function pullOrSnapshot(
  cursor: RevisionCursor | null,
  pullChanges: (from: RevisionCursor) => Promise<boolean>,
  snapshot: () => Promise<void>,
): Promise<void> {
  if (cursor && await pullChanges(cursor)) return;
  await snapshot();
}
