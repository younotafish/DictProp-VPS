import { log, warn } from './logger';

/** How far restoring this device's images to the server has got. */
export interface ImageRestoreProgress { phase: 'checking' | 'uploading' | 'done' | 'failed'; done: number; total: number; failed: number }

export interface ImageRestoreJob {
  /** The ids of the images the server has. */
  serverImageIds: () => Promise<Set<string>>;
  /** The ids of the images this device stores. */
  storedImageIds: () => Promise<Set<string>>;
  /** The ids of the pictures the library's current cards show, read once both lists are in. */
  liveImageIds: () => Set<string>;
  loadImages: (ids: string[]) => Promise<Map<string, Blob | string>>;
  upload: (images: Record<string, Blob | string>) => Promise<unknown>;
  report: (progress: ImageRestoreProgress) => void;
}

// Images uploaded per request batch.
const RESTORE_BATCH = 8;

/**
 * Re-uploads the images this device stores that the server lacks (once lost to an old marker bug), for cards
 * still in the library, a few at a time. An image this device lists but can't read counts as failed, as does
 * every image in a batch whose upload fails. Resolves to the final progress.
 */
export async function restoreImagesToServer({
  serverImageIds, storedImageIds, liveImageIds, loadImages, upload, report,
}: ImageRestoreJob): Promise<ImageRestoreProgress> {
  report({ phase: 'checking', done: 0, total: 0, failed: 0 });
  const [manifest, localIds] = await Promise.all([serverImageIds(), storedImageIds()]);

  // Only restore images that belong to a current (non-deleted) item or vocab.
  const liveIds = liveImageIds();

  const missing = [...localIds].filter(id => !manifest.has(id) && liveIds.has(id));
  log(`🖼️ Restore: ${localIds.size} local, ${manifest.size} on server, ${missing.length} to upload`);
  if (missing.length === 0) return { phase: 'done', done: 0, total: 0, failed: 0 };

  report({ phase: 'uploading', done: 0, total: missing.length, failed: 0 });
  let done = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i += RESTORE_BATCH) {
    const batchIds = missing.slice(i, i + RESTORE_BATCH);
    const map = Object.fromEntries(await loadImages(batchIds));
    const found = Object.keys(map).length;
    // An image this device lists but can't read is one it can't restore either.
    failed += batchIds.length - found;
    if (found > 0) {
      try { await upload(map); } catch (e) { failed += found; warn('Restore upload batch failed:', e); }
    }
    done += batchIds.length;
    report({ phase: 'uploading', done, total: missing.length, failed });
  }
  log(`🖼️ Restore complete: ${done - failed}/${missing.length} uploaded`);
  return { phase: 'done', done, total: missing.length, failed };
}
