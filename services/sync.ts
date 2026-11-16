import { keepServerOwnedData } from '../server/src/shared/server-owned-data';
import { getItemTitle, type StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import { warn } from './logger';
import { getItemContentHash, isItemDirty } from './itemHash';
import { getServerImageVersion } from './libraryImages';
import { isSameJson } from './sameJson';
import type { SaveItemsResult } from './api/library';

/** The flags this device last synced, found when the local copy differs from that sync only in its flags. */
const lastSyncedFlags = (item: StoredItem): { isDeleted?: true; isArchived?: true } | undefined => {
  if (!item.lastSyncedHash) return undefined;
  for (const isDeleted of [undefined, true] as const) {
    for (const isArchived of [undefined, true] as const) {
      if (getItemContentHash({ ...item, isDeleted, isArchived }) === item.lastSyncedHash) return { isDeleted, isArchived };
    }
  }
  return undefined;
};

/** The item with a schedule, a new one when it has none. */
const withSchedule = (item: StoredItem): StoredItem =>
  item.srs ? item : { ...item, srs: SRSAlgorithm.createNew(item.data.id, item.type) };

/** What the merge steps share about one local copy and the server copy of the same item. */
interface MergePair {
  local: StoredItem;
  remote: StoredItem;
  localRevision: number;
  remoteRevision: number;
  /** The copies carry different revisions, which outrank their timestamps. */
  revisionsDecide: boolean;
  localWinsRevision: boolean;
  /** The server's newer revision holds what this device last synced, so unsynced local edits go on top of it. */
  rebasesLocalEdits: boolean;
  /** Whether a flag changed here applies on top of a server copy that moved on without touching it. */
  keepsLocalFlag: (flag: 'isDeleted' | 'isArchived') => boolean;
}

/** The comparisons every step makes, worked out once. */
const describePair = (localItem: StoredItem, remoteItem: StoredItem): MergePair => {
  const localRevision = localItem.serverRevision ?? 0;
  const remoteRevision = remoteItem.serverRevision ?? 0;
  const revisionsDecide = localRevision !== remoteRevision;
  const localWinsRevision = localRevision > remoteRevision;
  // A newer revision whose content is what this device last synced (an image upload bumps the
  // revision, for one) doesn't conflict with unsynced local edits: rebase them onto it. A review on
  // another device changes only the schedule, which the SRS merge below takes on its own, so a remote
  // copy that matches once given the local schedule rebases too.
  const rebasesLocalEdits = revisionsDecide && !localWinsRevision && isItemDirty(localItem) &&
    (getItemContentHash(remoteItem) === localItem.lastSyncedHash ||
      getItemContentHash({ ...remoteItem, srs: localItem.srs }) === localItem.lastSyncedHash);
  // Deleting or archiving changes only a flag. When the server's copy moved on meanwhile without touching
  // that flag (the enrichment cycle rewrote the card, say), the change made here still applies on top.
  const syncedFlags = revisionsDecide && !localWinsRevision && !rebasesLocalEdits && isItemDirty(localItem)
    ? lastSyncedFlags(localItem)
    : undefined;
  const keepsLocalFlag = (flag: 'isDeleted' | 'isArchived'): boolean => !!syncedFlags &&
    (localItem[flag] || undefined) !== syncedFlags[flag] && (remoteItem[flag] || undefined) === syncedFlags[flag];
  return {
    local: localItem, remote: remoteItem, localRevision, remoteRevision, revisionsDecide, localWinsRevision,
    rebasesLocalEdits, keepsLocalFlag,
  };
};

// When the revisions don't decide (the same revision on both copies, or none), a deletion wins unless the other
// copy changed more than this much later.
const DELETION_GRACE_MS = 5000;

/**
 * 0. Deletions: the merged item when a deletion settles the pair, else undefined, and the content step decides.
 * A deletion wins unless the other copy is newer: by revision, or, when the revisions don't decide, by more
 * than DELETION_GRACE_MS. Of two deletions the newer one is kept.
 */
const resolveDeletion = (
  { local: localItem, remote: remoteItem, revisionsDecide, localWinsRevision, rebasesLocalEdits, keepsLocalFlag }: MergePair,
): StoredItem | undefined => {
  if (remoteItem.isDeleted && !localItem.isDeleted && !rebasesLocalEdits) {
    const remoteTime = remoteItem.updatedAt || 0;
    const localTime = localItem.updatedAt || 0;
    // Deletion wins if remote is newer OR within grace period
    if ((!revisionsDecide && remoteTime >= localTime - DELETION_GRACE_MS) ||
        (revisionsDecide && !localWinsRevision)) {
      return remoteItem;
    }
    // The local copy is newer, an edit made offline after the deletion, say: the content step decides.
    warn(`⚠️ Deletion conflict: Remote deleted at ${remoteTime}, but local updated at ${localTime}. Keeping local update.`);
  }

  if (localItem.isDeleted && !remoteItem.isDeleted && !rebasesLocalEdits) {
    const remoteTime = remoteItem.updatedAt || 0;
    const localTime = localItem.updatedAt || 0;
    // Deletion wins if local is newer OR within grace period
    if ((!revisionsDecide && localTime >= remoteTime - DELETION_GRACE_MS) ||
        (revisionsDecide && localWinsRevision)) {
      // Keep local deletion
      return localItem;
    }
    if (keepsLocalFlag('isDeleted')) {
      // On top of the server's revision, so the push that carries the deletion is accepted.
      return { ...structuredClone(remoteItem), isDeleted: true, updatedAt: localTime, lastSyncedHash: localItem.lastSyncedHash };
    }
    // The server copy is newer: the content step decides.
    warn(`⚠️ Deletion conflict: Local deleted at ${localTime}, but remote updated at ${remoteTime}. Keeping remote update.`);
  }

  // Both deleted: keep the newer deletion, and merge nothing else.
  if (localItem.isDeleted && remoteItem.isDeleted) {
    const remoteTime = remoteItem.updatedAt || 0;
    const localTime = localItem.updatedAt || 0;
    return (revisionsDecide ? !localWinsRevision : remoteTime > localTime) ? remoteItem : localItem;
  }
  return undefined;
};

// Builds before dba596d kept a stripped copy of the library in localStorage (no definitions, examples or
// history) and could write it back to IndexedDB after iOS cleared the database. Records written that way can
// still be on a device, and a tab that hasn't reloaded since can write more, so a copy without its content
// never replaces one that has it.
const hasFullContent = (item: StoredItem): boolean => {
  const data = item.data as any;
  if (item.type === 'sentence') return typeof data.text === 'string' && data.text.trim().length > 0;
  if (item.type === 'phrase') {
    return typeof data.grammar === 'string' || Array.isArray(data.vocabs);
  }
  return typeof data.definition === 'string' || Array.isArray(data.examples);
};

/** A. Content: a copy of the server's item carrying the content, timestamps and flags that win. */
const mergeContent = (
  { local: localItem, remote: remoteItem, localRevision, remoteRevision, revisionsDecide, localWinsRevision, rebasesLocalEdits, keepsLocalFlag }: MergePair,
): StoredItem => {
  // Unlike the deletion rule, a copy without updatedAt falls back to when it was saved.
  const localTime = localItem.updatedAt || localItem.savedAt || 0;
  const remoteTime = remoteItem.updatedAt || remoteItem.savedAt || 0;

  // A copy, so neither input is mutated.
  const mergedItem: StoredItem = structuredClone(remoteItem);

  const localHasContent = hasFullContent(localItem);
  const remoteHasContent = hasFullContent(remoteItem);

  // Equal revisions share a base, so the local copy holds any unsynced edits on top of it.
  // Timestamps decide only for items that never received a revision.
  if (rebasesLocalEdits || (revisionsDecide ? localWinsRevision : (localRevision > 0 || localTime > remoteTime))) {
    if (localHasContent || !remoteHasContent) {
      const remoteData = mergedItem.data;
      mergedItem.data = structuredClone(localItem.data);
      // The server's copy of the same base kept the server-owned fields a save here left out (only server-side jobs
      // write them), by the rule the server's own writes follow.
      if (!localWinsRevision && remoteRevision > 0) {
        mergedItem.data = keepServerOwnedData(mergedItem.data, localItem.type, remoteData, remoteItem.type);
      }
    }
    // Otherwise the local copy is stripped (see hasFullContent) and the server's content stays.
    mergedItem.updatedAt = localTime;
    mergedItem.savedAt = localItem.savedAt;
    mergedItem.isDeleted = localItem.isDeleted;
    mergedItem.isArchived = localItem.isArchived;
    mergedItem.serverRevision = rebasesLocalEdits ? remoteItem.serverRevision : localItem.serverRevision;
  }
  if (keepsLocalFlag('isArchived')) mergedItem.isArchived = localItem.isArchived || undefined;
  return mergedItem;
};

/** B. Schedule: the learning progress that wins, set on `mergedItem`. */
const mergeSchedule = ({ local: localItem, remote: remoteItem, localRevision, remoteRevision }: MergePair, mergedItem: StoredItem): void => {
  const localHistory = localItem.srs?.totalReviews || 0;
  const remoteHistory = remoteItem.srs?.totalReviews || 0;

  // A copy with no unsynced change holds only what the server sent or accepted, so the server's schedule
  // at the same or a newer revision replaces it, even an older one: another device undid a review.
  // Otherwise the newer lastReviewDate wins: each review stamps it with the time of the review.
  // A reset sets totalReviews to 0 and stamps lastReviewDate with the reset time (SRSAlgorithm.reset), so
  // totalReviews can't lead: the newer lastReviewDate wins, and totalReviews only breaks a tie.
  const localReview = localItem.srs?.lastReviewDate || 0;
  const remoteReview = remoteItem.srs?.lastReviewDate || 0;

  if (remoteRevision > 0 && remoteRevision >= localRevision && !isItemDirty(localItem)) {
    // The server's schedule is already in mergedItem.
  } else if (localReview > remoteReview) {
    // Local was reviewed more recently — local SRS wins
    mergedItem.srs = structuredClone(localItem.srs);
  } else if (localReview === remoteReview) {
    // Same review timestamp — use totalReviews as tiebreaker
    if (localHistory > remoteHistory) {
      mergedItem.srs = structuredClone(localItem.srs);
    }
  } else if (localHistory > remoteHistory) {
    // The server's newer review (already in mergedItem) wins with fewer repetitions: a reset elsewhere, say.
    warn(`[MERGE] "${getItemTitle(localItem)}" SRS: keeping remote (reviewed more recently) reviews ${localHistory}→${remoteHistory}, localReview=${new Date(localReview).toISOString()}, remoteReview=${new Date(remoteReview).toISOString()}`);
  }

  // Passive sentence exposure has its own conflict clock. It must survive merges without being
  // promoted into lastReviewDate (which would corrupt FSRS elapsed-time calculations) or allowing
  // a stale device to overwrite newer explicit review progress.
  const latestExposure = Math.max(
    localItem.srs?.lastExposureDate ?? 0,
    remoteItem.srs?.lastExposureDate ?? 0,
  );
  if (latestExposure > 0 && (mergedItem.srs?.lastExposureDate ?? 0) !== latestExposure) {
    mergedItem.srs = { ...mergedItem.srs, lastExposureDate: latestExposure };
  }
  if (mergedItem.type === 'sentence' && (mergedItem.srs?.totalReviews ?? 0) === 0) {
    // Old autoplay builds wrote passive credit into stability. Normalize it even when the remote
    // copy won the ordinary review-clock comparison, then let dirty sync repair the server copy.
    mergedItem.srs = SRSAlgorithm.migrate(mergedItem.srs);
  }
};

/** C. Pictures: the image markers that win, set on `mergedItem`'s data. */
const mergeImages = ({ local: localItem, remote: remoteItem }: MergePair, mergedItem: StoredItem): void => {
  // Items carry image markers, not pictures: 'idb:stored' for one stored on this device, and
  // 'server:has_image:<version>' for one on the server. The list endpoint never sends pictures, so a local
  // marker is kept unless the server's copy is current and carries a versioned marker, which replaces it so the
  // stored picture is checked against that version.
  const finalData = mergedItem.data as any;
  const localData = localItem.data as any;
  const remoteData = remoteItem.data as any;
  const remoteImageRevisionIsCurrent =
    typeof remoteItem.serverRevision === 'number' && typeof localItem.serverRevision === 'number'
      ? remoteItem.serverRevision > localItem.serverRevision ||
        (remoteItem.serverRevision === localItem.serverRevision &&
          (remoteItem.updatedAt || 0) >= (localItem.updatedAt || 0))
      : (remoteItem.updatedAt || 0) >= (localItem.updatedAt || 0);
  const remoteCanInvalidateImageCache = (imageUrl: unknown): imageUrl is string =>
    typeof imageUrl === 'string' &&
    getServerImageVersion(imageUrl) !== undefined &&
    remoteImageRevisionIsCurrent;

  if (remoteCanInvalidateImageCache(remoteData.imageUrl)) {
    finalData.imageUrl = remoteData.imageUrl;
  } else if (localData.imageUrl) {
    // Local has an image - always keep it
    finalData.imageUrl = localData.imageUrl;
  } else if (remoteData.imageUrl && !finalData.imageUrl) {
    // Local has no image, but remote does - use remote
    finalData.imageUrl = remoteData.imageUrl;
  }

  // Phrase vocab arrays can be reordered when content is refreshed. Reconcile
  // images by stable vocab id, never by array position.
  if (mergedItem.type === 'phrase' && Array.isArray(finalData.vocabs)) {
    const localVocabs = new Map(
      (Array.isArray(localData.vocabs) ? localData.vocabs : [])
        .filter((v: any) => v?.id)
        .map((v: any) => [v.id, v]),
    );
    const remoteVocabs = new Map(
      (Array.isArray(remoteData.vocabs) ? remoteData.vocabs : [])
        .filter((v: any) => v?.id)
        .map((v: any) => [v.id, v]),
    );
    finalData.vocabs.forEach((vocab: any) => {
      const localVocab: any = localVocabs.get(vocab?.id);
      const remoteVocab: any = remoteVocabs.get(vocab?.id);

      if (remoteCanInvalidateImageCache(remoteVocab?.imageUrl)) {
        vocab.imageUrl = remoteVocab.imageUrl;
      } else if (localVocab?.imageUrl) {
        vocab.imageUrl = localVocab.imageUrl;
      } else if (remoteVocab?.imageUrl && !vocab.imageUrl) {
        vocab.imageUrl = remoteVocab.imageUrl;
      }
    });
  }
};

/**
 * One local copy merged with the server's copy of the same item: deletions first, then content, schedule and
 * pictures. Returns `local` itself when the merge changes nothing.
 */
export const mergeItem = (local: StoredItem, remote: StoredItem): StoredItem => {
  const localItem = withSchedule(local);
  const remoteItem = withSchedule(remote);
  const pair = describePair(localItem, remoteItem);
  const settled = resolveDeletion(pair);
  if (settled) return settled;
  const mergedItem = mergeContent(pair);
  mergeSchedule(pair, mergedItem);
  mergeImages(pair, mergedItem);

  // Preserve local sync tracking state through merge
  mergedItem.lastSyncedHash = localItem.lastSyncedHash;

  // Keep the local object when the merge changed nothing, so persistence and hash caches skip it.
  return isSameJson(mergedItem, localItem) ? localItem : mergedItem;
};

/**
 * The library merged with server copies: each server item merges with the local copy of the same id
 * (mergeItem), or is appended when there is none. Local items keep their order; items without an id drop out.
 */
export const mergeDatasets = (local: StoredItem[], remote: StoredItem[]): StoredItem[] => {
  const map = new Map<string, StoredItem>();

  // Add all local items first (ensure SRS exists)
  local.forEach(item => {
    if (item.data && item.data.id) map.set(item.data.id, withSchedule(item));
  });

  // Merge remote items
  remote.forEach(item => {
    if (!item.data || !item.data.id) return;
    // Ensure remote item has SRS data
    const remoteItem = withSchedule(item);
    const localItem = map.get(remoteItem.data.id);
    // New item from cloud - use as-is
    map.set(remoteItem.data.id, localItem ? mergeItem(localItem, remoteItem) : remoteItem);
  });

  return Array.from(map.values());
};

const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drops deletions older than the retention period, which every device has long since pulled. Unsynced
 * deletions stay until pushed. Returns the same array when nothing expired.
 */
export const dropExpiredTombstones = (
  items: StoredItem[],
  now = Date.now(),
): { items: StoredItem[]; droppedIds: string[] } => {
  const droppedIds: string[] = [];
  const kept = items.filter(item => {
    if (!item.isDeleted || now - (item.updatedAt || 0) <= TOMBSTONE_RETENTION_MS || isItemDirty(item)) return true;
    droppedIds.push(item.data.id);
    return false;
  });
  return { items: droppedIds.length > 0 ? kept : items, droppedIds };
};

/**
 * Records the content the server holds, so an item is dirty exactly when it differs from its server
 * copy. A complete server snapshot also marks the items it lacks as dirty. Returns the same array when
 * nothing changed, and unchanged items keep their identity.
 */
export const trackServerContent = (
  items: StoredItem[],
  serverItems: readonly StoredItem[],
  { complete = false }: { complete?: boolean } = {},
): StoredItem[] => {
  const serverCopies = new Map(serverItems.map(item => [item.data.id, item]));
  let changed = false;
  const next = items.map(item => {
    const serverCopy = serverCopies.get(item.data.id);
    if (!serverCopy && !complete) return item;
    // A copy older than the item's revision (a review response landed meanwhile) is no longer current.
    if (serverCopy && (serverCopy.serverRevision ?? 0) < (item.serverRevision ?? 0)) return item;
    const serverHash = serverCopy ? getItemContentHash(serverCopy) : undefined;
    if (item.lastSyncedHash === serverHash) return item;
    changed = true;
    return { ...item, lastSyncedHash: serverHash };
  });
  return changed ? next : items;
};

/**
 * A local item after the server applied or undid a review of it. The server's schedule is authoritative,
 * since an undo moves it backwards. Its content is too, and may carry another device's edits, unless this
 * device has unsynced edits to push on top and the server changed nothing but the schedule since this
 * device's copy: `baseRevision`, the item's revision before the review, is the one the copy holds.
 * Otherwise the edits meet the server's copy in an ordinary merge, as a pull would: adopting only its
 * revision would hide its changes, and the next push would overwrite them.
 */
export const reconcileReviewedItem = (
  local: StoredItem,
  serverItem: StoredItem,
  baseRevision: number | undefined,
): StoredItem => {
  const reconciled = isItemDirty(local) && baseRevision !== undefined && baseRevision === (local.serverRevision ?? 0)
    ? {
        ...local,
        serverRevision: serverItem.serverRevision,
        updatedAt: Math.max(local.updatedAt || 0, serverItem.updatedAt || 0),
      }
    : mergeItem(local, serverItem);
  return { ...reconciled, srs: serverItem.srs, lastSyncedHash: getItemContentHash(serverItem) };
};

/**
 * Applies a push result without mutating items that React state shares. `pushed` must hold the exact
 * copies that were sent: an item edited again while its push was in flight keeps the newer content
 * and stays dirty. Returns the same array when nothing changed.
 */
export const applyServerSave = (
  items: StoredItem[],
  pushed: readonly StoredItem[],
  result: Pick<SaveItemsResult, 'revisions' | 'canonical'> & Partial<Pick<SaveItemsResult, 'kept'>>,
): StoredItem[] => {
  const sentCopies = new Map(pushed.map(item => [item.data.id, item]));
  let changed = false;
  const next = items.map(item => {
    const sent = sentCopies.get(item.data.id);
    if (!sent) return item;
    // Review responses apply outside the sync lane and may already have recorded a newer server copy.
    const localRevision = item.serverRevision ?? 0;
    const canonical = result.canonical.get(item.data.id);
    if (canonical) {
      // The server kept its own content (a conflict or a server-side enrichment): adopt it like a pull.
      if ((canonical.serverRevision ?? 0) < localRevision) return item;
      changed = true;
      return { ...mergeItem(item, canonical), lastSyncedHash: getItemContentHash(canonical) };
    }
    const revision = result.revisions.get(item.data.id);
    if (revision === undefined || revision < localRevision) return item;
    // When the server kept server-owned fields the push left out, it holds the sent copy with them. They're filled in
    // here by the rule it applied, so the copy matches the row without waiting for a pull. They fill only what a copy
    // lacks, and only server jobs write them, so an edit made while the push was in flight stays, and keeps the item
    // dirty. A copy deleted meanwhile takes none, as the server keeps none for a deletion.
    const kept = result.kept?.get(item.data.id);
    const synced = kept ? { ...sent, data: keepServerOwnedData(sent.data, sent.type, kept, sent.type) } : sent;
    const syncedHash = getItemContentHash(synced);
    const data = kept && !item.isDeleted ? keepServerOwnedData(item.data, item.type, kept, sent.type) : item.data;
    if (data === item.data && revision === localRevision && item.lastSyncedHash === syncedHash) return item;
    changed = true;
    return { ...item, data, serverRevision: revision, lastSyncedHash: syncedHash };
  });
  return changed ? next : items;
};
