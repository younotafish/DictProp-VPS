import { defaultStorage, parseJson, type StorageLike } from './browserStorage';

// Pictures stored on this device whose upload failed, listed by id so a later run can send them
// (libraryImages.retryPendingImageUploads). Only ids live here; the pictures stay in IndexedDB. The list is one
// value, so two tabs listing at the same moment can drop each other's addition: such a picture waits for "Restore
// images to server", as every failed upload did before this list.

const pendingKey = (userId: string) => `image_uploads_pending_${userId}`;
// A long offline session lists at most this many; the oldest drop off first.
const MAX_PENDING_UPLOADS = 200;

/** The ids of pictures waiting to be uploaded, oldest first. */
export function readPendingImageUploads(userId: string, storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage || !userId) return [];
  try {
    const parsed = parseJson(storage.getItem(pendingKey(userId)));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingImageUploads(userId: string, ids: readonly string[], storage: StorageLike): void {
  try {
    if (ids.length === 0) storage.removeItem(pendingKey(userId));
    else storage.setItem(pendingKey(userId), JSON.stringify(ids));
  } catch {
    // Storage is full or refused: the picture stays on this device for "Restore images to server".
  }
}

/** Lists pictures whose upload failed, each once, keeping the newest MAX_PENDING_UPLOADS. */
export function addPendingImageUploads(
  userId: string,
  ids: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !userId || ids.length === 0) return;
  const added = new Set(ids);
  const kept = readPendingImageUploads(userId, storage).filter(id => !added.has(id));
  writePendingImageUploads(userId, [...kept, ...added].slice(-MAX_PENDING_UPLOADS), storage);
}

/** Takes pictures off the list: uploaded, or no longer on this device. */
export function removePendingImageUploads(
  userId: string,
  ids: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !userId || ids.length === 0) return;
  const removed = new Set(ids);
  const pending = readPendingImageUploads(userId, storage);
  const rest = pending.filter(id => !removed.has(id));
  if (rest.length !== pending.length) writePendingImageUploads(userId, rest, storage);
}
