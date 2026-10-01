import { useCallback, useRef, useState } from 'react';
import type { RevisionCursor, StoredItem } from '../types';
import type { AuthUser } from '../services/auth';
import { deleteItemRecords, saveData, saveItemUpdates } from '../services/storage';
import { applyServerSave, dropExpiredTombstones, mergeDatasets, trackServerContent } from '../services/sync';
import { getItemContentHash, isItemDirty } from '../services/itemHash';
import { loadAllItems, loadItemChanges, saveItems } from '../services/api';
import { excludePendingReviewItems } from '../services/reviewQueue';
import { log, warn, error as logError } from '../services/logger';
import type { UndoOffer } from './useUndoOffer';

/** The library in memory, and the pulls and pushes that keep it in step with the server. */
export function useLibrary(user: AuthUser | null) {
  // The library. IndexedDB is the only local copy.
  const [savedItems, setSavedItems] = useState<StoredItem[]>([]);
  // The library as of the latest change, for handlers and async work that outlive a render.
  const latestItemsRef = useRef<StoredItem[]>(savedItems);
  // The server change the library is current to, stored with it; pulls resume after it. Null until a
  // full snapshot establishes one.
  const serverCursorRef = useRef<RevisionCursor | null>(null);

  /**
   * Every library change goes through here. The transform sees the latest items rather than a
   * render's snapshot, and the ref is current before this returns, so the next handler, IndexedDB
   * write or server push sees the change. An update that replaces no item keeps the old array, so
   * derived indexes don't rebuild.
   */
  const updateItems = useCallback((transform: (items: StoredItem[]) => StoredItem[]): StoredItem[] => {
    const current = latestItemsRef.current;
    const next = transform(current);
    if (next === current || (next.length === current.length && next.every((item, index) => item === current[index]))) {
      return current;
    }
    latestItemsRef.current = next;
    setSavedItems(next);
    return next;
  }, []);

  /** Replaces one item by id. Returns the new copy, or undefined when the id isn't in the library. */
  const replaceItem = useCallback((id: string, update: (item: StoredItem) => StoredItem): StoredItem | undefined => {
    let replaced = undefined as StoredItem | undefined;
    updateItems(items => {
      const index = items.findIndex(item => item.data.id === id);
      if (index < 0) return items;
      replaced = update(items[index]);
      const next = items.slice();
      next[index] = replaced;
      return next;
    });
    return replaced;
  }, [updateItems]);

  // The account whose library is in memory. A session that lapses keeps it, so the library is never saved
  // under another name while the sign-in screen shows.
  const currentUserIdRef = useRef(user?.id || 'vps');
  if (user) currentUserIdRef.current = user.id;

  // User-scoped saveData wrapper — all saves go through this
  const userSaveData = useCallback((items: StoredItem[]) => saveData(items, currentUserIdRef.current), []);

  const initialServerSyncDoneRef = useRef(false);
  // A launch whose first sync failed (offline, say) leaves the push of changes made before it, and the
  // image download, to the first background pull that gets through.
  const initialSyncIncompleteRef = useRef(false);

  // Pulls and pushes run one at a time: a pull merges only after an earlier push's acknowledgement is
  // recorded, and each push sends the latest copies. Tasks in the lane call pushNow, not pushDirtyItems,
  // which would wait on the lane itself.
  const syncLaneRef = useRef<Promise<unknown>>(Promise.resolve());
  const inSyncLane = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = syncLaneRef.current.then(task, task);
    syncLaneRef.current = run.catch(() => {});
    return run;
  }, []);

  // Items the server refused, with the content it refused: sending that again would be refused again.
  const refusedPushesRef = useRef(new Map<string, string>());
  // A change the user can still undo stays on this device until the offer closes, so an undone change never
  // reaches the server or another device.
  const undoOfferRef = useRef<UndoOffer | null>(null);

  /** Pushes the dirty items (all, or those in `ids`) and records what the server kept. Returns the count. */
  const pushNow = useCallback(async (ids?: ReadonlySet<string>): Promise<number> => {
    const refused = refusedPushesRef.current;
    const held = undoOfferRef.current?.id;
    const dirty = latestItemsRef.current.filter(item => (!ids || ids.has(item.data.id)) && item.data.id !== held &&
      isItemDirty(item) && refused.get(item.data.id) !== getItemContentHash(item));
    // Items with an unsent review wait for the review outbox, which applies the review atomically.
    const toPush = excludePendingReviewItems(dirty, currentUserIdRef.current);
    if (toPush.length === 0) return 0;
    const result = await saveItems(toPush);
    const next = updateItems(items => applyServerSave(items, toPush, result));
    await saveData(next, currentUserIdRef.current);
    for (const [id, reason] of result.rejected ?? []) {
      const item = toPush.find(candidate => candidate.data.id === id);
      if (item) refused.set(id, getItemContentHash(item));
      logError(`The server refused item ${id}, which stays on this device until it changes: ${reason}`);
    }
    if (result.error) throw result.error;
    return toPush.length;
  }, [updateItems]);

  const pushDirtyItems = useCallback(
    (ids?: ReadonlySet<string>) => inSyncLane(() => pushNow(ids)),
    [inSyncLane, pushNow],
  );

  // The pulls below run in the sync lane.

  /** Merges server copies and stores the result together with the cursor they bring it up to. */
  const mergeServerItems = useCallback(async (
    remoteItems: StoredItem[],
    cursor: RevisionCursor,
    { complete = false }: { complete?: boolean } = {},
  ): Promise<void> => {
    let droppedIds: string[] = [];
    const merged = updateItems(items => {
      const next = trackServerContent(mergeDatasets(items, remoteItems), remoteItems, { complete });
      if (!complete) return next;
      // A snapshot brings back the expired tombstones the server still keeps.
      const pruned = dropExpiredTombstones(next);
      droppedIds = pruned.droppedIds;
      return pruned.items;
    });
    serverCursorRef.current = cursor;
    await deleteItemRecords(droppedIds, currentUserIdRef.current)
      .catch(error => warn('Expired deletions stay stored until the next launch:', error));
    await saveData(merged, currentUserIdRef.current, cursor);
  }, [updateItems]);

  /**
   * Merges the server changes after `from`. False when the server is behind the cursor: its database
   * was replaced, so only a full snapshot can reconcile.
   */
  const pullChanges = useCallback(async (from: RevisionCursor): Promise<boolean> => {
    let cursor = from;
    const remoteItems: StoredItem[] = [];
    for (;;) {
      const page = await loadItemChanges(cursor);
      if (page.headRevision !== undefined && page.headRevision < from.revision) return false;
      remoteItems.push(...page.items);
      const advanced = page.cursor.revision > cursor.revision ||
        (page.cursor.revision === cursor.revision && page.cursor.id > cursor.id);
      cursor = page.cursor;
      if (!page.hasMore || !advanced) break;
    }
    if (remoteItems.length === 0) return true;
    await mergeServerItems(remoteItems, cursor);
    log(`Server: pulled ${remoteItems.length} changed item(s)`);
    return true;
  }, [mergeServerItems]);

  /** Merges a complete snapshot. Local items the server lacks turn dirty, so they upload. */
  const syncFullSnapshot = useCallback(async (): Promise<void> => {
    const { items: remoteItems, cursor } = await loadAllItems();
    // An empty server isn't authoritative: merging it would re-upload the whole library.
    if (remoteItems.length === 0) {
      serverCursorRef.current = cursor;
      return;
    }
    await mergeServerItems(remoteItems, cursor, { complete: true });
    log(`Server: merged a full snapshot of ${remoteItems.length} items`);
  }, [mergeServerItems]);

  /** Pulls what changed since the stored cursor, or a full snapshot when there is no usable cursor. */
  const syncWithServer = useCallback(async (): Promise<void> => {
    const cursor = serverCursorRef.current;
    if (cursor && await pullChanges(cursor)) return;
    await syncFullSnapshot();
  }, [pullChanges, syncFullSnapshot]);

  // Durable local write first, then an immediate push. A failed push leaves the items dirty, and the
  // debounced save retries them.
  const persistChangedItems = useCallback(async (items: StoredItem[], label: string): Promise<void> => {
    if (items.length === 0) return;
    try {
      await saveItemUpdates(items, currentUserIdRef.current);
    } catch (error) {
      logError(`${label}: failed to save the local update`, error);
    }

    try {
      await pushDirtyItems(new Set(items.map(item => item.data.id)));
    } catch (error) {
      logError(`${label}: immediate server sync failed`, error);
    }
  }, [pushDirtyItems]);

  return {
    savedItems, latestItemsRef, serverCursorRef, updateItems, replaceItem, currentUserIdRef, userSaveData,
    initialServerSyncDoneRef, initialSyncIncompleteRef, inSyncLane, refusedPushesRef, undoOfferRef,
    pushNow, pushDirtyItems, syncFullSnapshot, syncWithServer, persistChangedItems,
  };
}

export type Library = ReturnType<typeof useLibrary>;
