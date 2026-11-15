import { checkIndexedDBAvailability, IMAGES_STORE, transactionDone, withDB } from './idb';
import { dataUriToBlob } from './dataUri';
import { warn } from './logger';

// Pictures kept on this device: IndexedDB records by item id, a memory cache of their blob URLs, decoded images
// held ahead of the cards that show them, and the queries the offline download and recovery make.

// In-memory LRU cache for frequently accessed images
interface CachedImageEntry {
  url: string;
  version?: string;
}

interface StoredImageRecord {
  blob: Blob | string;
  version?: string;
}

const imageCache = new Map<string, CachedImageEntry>();
const IMAGE_CACHE_MAX = 50;

const isStoredImageRecord = (value: unknown): value is StoredImageRecord =>
  !!value && typeof value === 'object' && !(value instanceof Blob) && 'blob' in value;

const releaseImage = (entry: CachedImageEntry | undefined) => {
  if (entry?.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
};

/** Caches an item's picture as the most recently used, evicting the oldest past the limit. */
const rememberImage = (itemId: string, url: string, version?: string) => {
  const previous = imageCache.get(itemId);
  if (previous?.url !== url) releaseImage(previous);
  imageCache.delete(itemId);
  imageCache.set(itemId, { url, version });
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const [oldestId, oldest] = imageCache.entries().next().value!;
    releaseImage(oldest);
    imageCache.delete(oldestId);
  }
};

/** The item's picture if it's already in memory, so a view can show it on its first frame. */
export const peekImage = (itemId: string, expectedVersion?: string): string | null => {
  const cached = imageCache.get(itemId);
  if (!cached || (expectedVersion && cached.version !== expectedVersion)) return null;
  imageCache.delete(itemId);
  imageCache.set(itemId, cached);
  return cached.url;
};

/** A picture to store: a downloaded file, or a data URI from a paste or an import. */
export interface ImageToStore {
  id: string;
  image: Blob | string;
  version?: string;
}

const toBlob = (image: Blob | string): Blob => typeof image === 'string' ? dataUriToBlob(image) : image;

/** Writes pictures to IDB in one transaction. A failed write only costs the offline copy, so it's logged. */
const putImages = async (images: Array<{ id: string; blob: Blob; version?: string }>): Promise<void> => {
  if (!(await checkIndexedDBAvailability())) return;
  try {
    await withDB(db => {
      const tx = db.transaction(IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE);
      for (const { id, blob, version } of images) {
        store.put(version ? { blob, version } satisfies StoredImageRecord : blob, id);
      }
      return transactionDone(tx);
    });
  } catch (e) {
    warn("Failed to save images to IDB", e);
  }
};

/**
 * Caches a picture in memory and stores it in the background. Returns the URL to show it with, so a card
 * doesn't wait on the IDB write.
 */
export const saveImage = (itemId: string, image: Blob | string, version?: string): string => {
  const blob = toBlob(image);
  const url = URL.createObjectURL(blob);
  rememberImage(itemId, url, version);
  void putImages([{ id: itemId, blob, version }]);
  return url;
};

/**
 * Stores pictures in IDB. `remember` also puts them in the memory cache; bulk downloads skip it so they
 * don't push out the pictures of the cards just viewed.
 */
export const saveImagesBatch = async (images: ImageToStore[], { remember = true } = {}): Promise<void> => {
  if (images.length === 0) return;
  const blobs = images.map(({ id, image, version }) => ({ id, blob: toBlob(image), version }));
  if (remember) {
    for (const { id, blob, version } of blobs) rememberImage(id, URL.createObjectURL(blob), version);
  }
  await putImages(blobs);
};

// One IDB read per picture at a time. Two concurrent reads would each mint a blob URL, and caching the
// second revokes the first while a view may still be about to show it.
const pendingImageLoads = new Map<string, Promise<string | null>>();

export const loadImage = (itemId: string, expectedVersion?: string): Promise<string | null> => {
  const cached = peekImage(itemId, expectedVersion);
  if (cached) return Promise.resolve(cached);
  const key = `${itemId}\n${expectedVersion ?? ''}`;
  let pending = pendingImageLoads.get(key);
  if (!pending) {
    pending = readStoredImage(itemId, expectedVersion).finally(() => pendingImageLoads.delete(key));
    pendingImageLoads.set(key, pending);
  }
  return pending;
};

const readStoredImage = async (itemId: string, expectedVersion?: string): Promise<string | null> => {
  const stale = imageCache.get(itemId);
  if (stale) {
    releaseImage(stale);
    imageCache.delete(itemId);
  }

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return null;

  try {
    return await withDB(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      const request = store.get(itemId);
      request.onsuccess = () => {
        const result = request.result as string | Blob | StoredImageRecord | undefined;
        const version = isStoredImageRecord(result) ? result.version : undefined;
        if (expectedVersion && version !== expectedVersion) {
          resolve(null);
          return;
        }
        // A download may have cached the picture while this read was in flight.
        const saved = peekImage(itemId, expectedVersion);
        if (saved) {
          resolve(saved);
          return;
        }
        const stored = isStoredImageRecord(result) ? result.blob : result;
        if (stored) {
          const url = stored instanceof Blob ? URL.createObjectURL(stored) : stored;
          rememberImage(itemId, url, version);
          resolve(url);
          return;
        }
        resolve(null);
      };
      request.onerror = () => reject(request.error);
    }));
  } catch (e) {
    warn("Failed to load image from IDB", e);
    return null;
  }
};

// Pictures decoded ahead of the cards they belong to. Holding the elements keeps the browser from
// dropping them before those cards are shown.
const decodedImages = new Map<string, HTMLImageElement>();
const DECODED_IMAGES_MAX = 12;

/**
 * Has the browser fetch and decode a picture ahead of time, so an <img> showing it later is complete as
 * soon as it's attached. Resolves false if the picture can't be loaded.
 */
export const decodeImage = async (url: string): Promise<boolean> => {
  if (decodedImages.has(url)) return true;
  const img = new Image();
  img.src = url;
  decodedImages.set(url, img);
  if (decodedImages.size > DECODED_IMAGES_MAX) decodedImages.delete(decodedImages.keys().next().value!);
  try {
    await img.decode();
    return true;
  } catch {
    if (decodedImages.get(url) === img) decodedImages.delete(url);
    return false;
  }
};

/**
 * Loads an item's stored picture into memory and decodes it, so moving to its card shows the picture on
 * the first frame. Resolves false when the picture isn't stored locally.
 */
export const warmImage = async (itemId: string, expectedVersion?: string): Promise<boolean> => {
  const url = await loadImage(itemId, expectedVersion);
  if (!url) return false;
  await decodeImage(url);
  return true;
};

/**
 * Check which of the given IDs already have images stored in IDB.
 * Returns the set of IDs that DO have images (i.e., don't need fetching).
 */
export const getStoredImageIds = async (
  ids: string[],
  expectedVersions?: ReadonlyMap<string, string>,
): Promise<Set<string>> => {
  const found = new Set<string>();
  if (ids.length === 0) return found;

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return found;

  try {
    await withDB(db => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      let pending = ids.length;
      for (const id of ids) {
        const expectedVersion = expectedVersions?.get(id);
        if (expectedVersion) {
          const req = store.get(id);
          req.onsuccess = () => {
            const value = req.result;
            if (isStoredImageRecord(value) && value.version === expectedVersion) found.add(id);
            if (--pending === 0) resolve();
          };
          req.onerror = () => { if (--pending === 0) resolve(); };
        } else {
          // Unversioned local/user images only need an existence check.
          const req = store.getKey(id);
          req.onsuccess = () => {
            if (req.result !== undefined) found.add(id);
            if (--pending === 0) resolve();
          };
          req.onerror = () => { if (--pending === 0) resolve(); };
        }
      }
      tx.onerror = () => reject(tx.error);
    }));
  } catch (e) {
    warn("Failed to check stored image IDs", e);
  }
  return found;
};

/**
 * Enumerate ALL image ids currently stored in IDB (the keys of the images store).
 * Used by the "restore images to server" recovery action to diff against the server.
 */
export const getAllStoredImageIds = async (): Promise<Set<string>> => {
  const found = new Set<string>();
  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return found;

  try {
    await withDB(db => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result as IDBValidKey[]) {
          if (typeof k === 'string') found.add(k);
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    }));
  } catch (e) {
    warn("Failed to enumerate stored image ids", e);
  }
  return found;
};

/** Batch-load stored pictures (files, or data URIs from older records) for the given ids; missing ids are omitted. */
export const loadImagesByIds = async (ids: string[]): Promise<Map<string, Blob | string>> => {
  const result = new Map<string, Blob | string>();
  if (ids.length === 0) return result;

  const idbAvailable = await checkIndexedDBAvailability();
  if (!idbAvailable) return result;

  try {
    await withDB(db => {
      const tx = db.transaction(IMAGES_STORE, 'readonly');
      const store = tx.objectStore(IMAGES_STORE);
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          const value = isStoredImageRecord(req.result) ? req.result.blob : req.result;
          if (typeof value === 'string' || value instanceof Blob) result.set(id, value);
        };
      }
      return transactionDone(tx);
    });
  } catch (e) {
    warn("Failed to load images by ids", e);
  }
  return result;
};
