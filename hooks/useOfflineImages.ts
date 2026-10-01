import { useCallback, useRef, useState } from 'react';
import type { StoredItem } from '../types';
import { getAllStoredImageIds, getStoredImageIds, loadImagesByIds, saveImagesBatch } from '../services/storage';
import { getServerImageManifest, loadItemImagesBatch, uploadImages } from '../services/api';
import { getServerImageVersion, isImageMarker } from '../services/libraryImages';
import { log, warn } from '../services/logger';
import type { ImageRestoreProgress } from '../components/AppStatus';
import type { Library } from './useLibrary';

/** Pictures kept for offline use: the study ones cached quietly, all of them on request, and restoring the server's. */
export function useOfflineImages({ latestItemsRef }: Pick<Library, 'latestItemsRef'>) {
  // Progress of the explicit offline-image download; the automatic caching of study pictures is silent.
  const [imagePrefetchProgress, setImagePrefetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [imageRestoreProgress, setImageRestoreProgress] = useState<ImageRestoreProgress | null>(null);
  // Starting the offline download, or stopping it, ends the image downloads under way. The new one fetches
  // whatever is still missing.
  const prefetchRunRef = useRef(0);

  // Cache a bounded set of study-relevant images by default. A full offline pack is explicit.
  const prefetchImages = useCallback(async (items: StoredItem[], mode: 'priority' | 'all' = 'priority') => {
    if (mode === 'priority') {
      const connection = (navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }).connection;
      if (connection?.saveData || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return;
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      if (estimate?.quota && estimate.usage && estimate.usage / estimate.quota > 0.85) return;
    }

    const candidates = mode === 'all'
      ? items
      : (() => {
          const now = Date.now();
          const dueSoon = items
            .filter(item => !item.isDeleted && !item.isArchived && (item.srs?.nextReview || 0) <= now + 24 * 60 * 60 * 1000)
            .sort((a, b) => (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0))
            .slice(0, 60);
          const recent = items
            .filter(item => !item.isDeleted && !item.isArchived)
            .sort((a, b) => b.savedAt - a.savedAt)
            .slice(0, 20);
          return Array.from(new Map([...dueSoon, ...recent].map(item => [item.data.id, item])).values());
        })();

    // Collect all item/vocab IDs that have image markers
    const idsWithImages: string[] = [];
    const imageVersions = new Map<string, string>();
    const addImageMarker = (id: string, imageUrl: string | undefined) => {
      if (!isImageMarker(imageUrl)) return;
      idsWithImages.push(id);
      const version = getServerImageVersion(imageUrl);
      if (version) imageVersions.set(id, version);
    };
    for (const item of candidates) {
      if (item.isDeleted || item.isArchived) continue;
      const data = item.data as any;
      addImageMarker(data.id, data.imageUrl);
      if (Array.isArray(data.vocabs)) {
        for (const v of data.vocabs) {
          addImageMarker(v.id, v.imageUrl);
        }
      }
    }
    if (idsWithImages.length === 0) return;

    // Check which IDs already have images in IDB
    const alreadyStored = await getStoredImageIds(idsWithImages, imageVersions);
    const missing = idsWithImages.filter(id => !alreadyStored.has(id));
    if (missing.length === 0) return;

    // Sort by SRS nextReview (soonest first) so study-relevant images load first
    const srsMap = new Map<string, number>();
    for (const item of candidates) {
      const nrd = (item.srs as any)?.nextReview;
      if (nrd) {
        srsMap.set(item.data.id, nrd);
        if (Array.isArray((item.data as any).vocabs)) {
          for (const v of (item.data as any).vocabs) {
            srsMap.set(v.id, nrd);
          }
        }
      }
    }
    missing.sort((a, b) => (srsMap.get(a) || Infinity) - (srsMap.get(b) || Infinity));

    log(`🖼️ Caching ${missing.length} ${mode === 'all' ? 'offline' : 'priority'} images...`);
    // Only the offline download supersedes others, so the pill it shows is always its own to clear.
    const run = mode === 'all' ? ++prefetchRunRef.current : prefetchRunRef.current;
    const report = mode === 'all' ? setImagePrefetchProgress : () => {};
    report({ done: 0, total: missing.length });

    const BATCH_SIZE = 20;
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      if (prefetchRunRef.current !== run) return;
      const batch = missing.slice(i, i + BATCH_SIZE);
      try {
        const images = await loadItemImagesBatch(batch, imageVersions);
        const toSave = [...images].map(([id, image]) => ({ id, image, version: imageVersions.get(id) }));
        if (toSave.length > 0) await saveImagesBatch(toSave, { remember: false });
      } catch (e) {
        warn("Image pre-fetch batch failed:", e);
      }
      done += batch.length;
      report({ done, total: missing.length });
      // Yield to main thread between batches
      await new Promise(r => setTimeout(r, 100));
    }
    log(`🖼️ Pre-fetch complete: ${done}/${missing.length} images`);
    // Clear progress after a short delay
    setTimeout(() => { if (prefetchRunRef.current === run) report(null); }, 3000);
  }, []);

  const stopImageDownload = useCallback(() => {
    prefetchRunRef.current++;
    setImagePrefetchProgress(null);
  }, []);

  const handleDownloadOfflineImages = useCallback(() => {
    void prefetchImages(latestItemsRef.current, 'all');
  }, [prefetchImages]);

  // Recovery: re-upload images that exist in THIS device's IndexedDB but are missing on
  // the server (e.g. images corrupted by the old marker-clobber bug). Run from a device
  // that still has the images cached. No-op on a fresh device (empty IDB).
  const handleRestoreImagesToServer = useCallback(async () => {
    // The last word stays up a little longer when something went wrong.
    const finish = (progress: ImageRestoreProgress) => {
      setImageRestoreProgress(progress);
      setTimeout(() => setImageRestoreProgress(null), progress.phase === 'failed' || progress.failed ? 6000 : 3000);
    };
    try {
      setImageRestoreProgress({ phase: 'checking', done: 0, total: 0, failed: 0 });
      const [manifest, localIds] = await Promise.all([
        getServerImageManifest(),
        getAllStoredImageIds(),
      ]);

      // Only restore images that belong to a current (non-deleted) item or vocab.
      const liveIds = new Set<string>();
      for (const item of latestItemsRef.current) {
        if (item.isDeleted) continue;
        liveIds.add(item.data.id);
        const vocabs = (item.data as any).vocabs;
        if (Array.isArray(vocabs)) for (const v of vocabs) if (v?.id) liveIds.add(v.id);
      }

      const missing = [...localIds].filter(id => !manifest.has(id) && liveIds.has(id));
      log(`🖼️ Restore: ${localIds.size} local, ${manifest.size} on server, ${missing.length} to upload`);
      if (missing.length === 0) {
        finish({ phase: 'done', done: 0, total: 0, failed: 0 });
        return;
      }

      setImageRestoreProgress({ phase: 'uploading', done: 0, total: missing.length, failed: 0 });
      const BATCH = 8;
      let done = 0;
      let failed = 0;
      for (let i = 0; i < missing.length; i += BATCH) {
        const batchIds = missing.slice(i, i + BATCH);
        const map = Object.fromEntries(await loadImagesByIds(batchIds));
        const found = Object.keys(map).length;
        // An image this device lists but can't read is one it can't restore either.
        failed += batchIds.length - found;
        if (found > 0) {
          try { await uploadImages(map); } catch (e) { failed += found; warn('Restore upload batch failed:', e); }
        }
        done += batchIds.length;
        setImageRestoreProgress({ phase: 'uploading', done, total: missing.length, failed });
      }
      log(`🖼️ Restore complete: ${done - failed}/${missing.length} uploaded`);
      finish({ phase: 'done', done, total: missing.length, failed });
    } catch (e) {
      warn('Restore images to server failed:', e);
      finish({ phase: 'failed', done: 0, total: 0, failed: 0 });
    }
  }, []);

  return { imagePrefetchProgress, imageRestoreProgress, prefetchImages, stopImageDownload, handleDownloadOfflineImages, handleRestoreImagesToServer };
}
