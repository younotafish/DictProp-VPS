import { isPhraseItem, isVocabItem, type SearchResult, type StoredItem, type VocabCard } from '../types';
import { loadItemImage } from './api/images';
import type { Offload } from './imagePipeline';
import { saveImage } from './imageStore';
import { readPendingImageUploads } from './imageUploadQueue';
import { log, warn } from './logger';

// Pictures stay out of the library in memory: each card carries a marker, and the picture lives in
// IndexedDB and on the server.

/** A picture held inline as a data URI, under the id it is stored and uploaded by. */
export interface InlineImage {
  id: string;
  base64: string;
}

/**
 * Stores pictures on this device and starts their upload (imagePipeline.offloadAndUpload, loaded on first use).
 * With a user id, pictures stored here whose upload fails are retried by retryPendingImageUploads.
 */
export const offloadImages = async (images: InlineImage[], userId?: string): Promise<Offload> => {
  const { offloadAndUpload } = await import('./imagePipeline');
  return offloadAndUpload(images, userId);
};

let pendingUploadRun: Promise<void> | null = null;

/**
 * Uploads the pictures whose upload failed after offloadImages stored them, one run at a time. Costs a storage read
 * when nothing waits: the upload code loads only when something does.
 */
export const retryPendingImageUploads = (userId: string): Promise<void> => {
  if (pendingUploadRun) return pendingUploadRun;
  if (readPendingImageUploads(userId).length === 0) return Promise.resolve();
  pendingUploadRun = import('./imagePipeline')
    .then(({ uploadPendingImages }) => uploadPendingImages(userId))
    .catch(error => warn('Pending image uploads wait for the next try:', error))
    .finally(() => { pendingUploadRun = null; });
  return pendingUploadRun;
};

// A picture already downloading is shared, so a card and the warm-up around it fetch it once, and a
// second copy can't replace (and revoke) the URL the card is about to show.
const imageDownloads = new Map<string, Promise<string | null>>();

/**
 * Downloads a picture missing locally, caches it, and resolves to the URL to show it with.
 * loadItemImage THROWS on a transient failure (OfflineImage retries) and returns null only for a
 * genuine 404, which stays empty until the Mac-local enrichment cycle generates and uploads it.
 */
export const lazyLoadImage = (itemId: string, imageVersion?: string): Promise<string | null> => {
  const key = `${itemId}\n${imageVersion ?? ''}`;
  let download = imageDownloads.get(key);
  if (!download) {
    download = loadItemImage(itemId, imageVersion)
      .then(image => image && saveImage(itemId, image, imageVersion))
      .finally(() => imageDownloads.delete(key));
    imageDownloads.set(key, download);
  }
  return download;
};

// Sentinel value replacing base64 in React state — tells OfflineImage to load from IDB
export const IMAGE_IDB_MARKER = 'idb:stored';
const SERVER_IMAGE_MARKER = 'server:has_image';
export const getServerImageVersion = (url: string | undefined): string | undefined =>
  url?.startsWith(`${SERVER_IMAGE_MARKER}:`)
    ? url.slice(SERVER_IMAGE_MARKER.length + 1)
    : undefined;

// The server versions a picture by its bytes: the first 20 hex digits of their SHA-256 are the version in its
// 'server:has_image:<version>' marker (server/src/db.ts).
export const imageVersionFromContentHash = (sha256Hex: string): string => sha256Hex.slice(0, 20);

// Check if an imageUrl is a marker (not real base64 data)
export const isImageMarker = (url: string | undefined): boolean =>
  !!url && (url === IMAGE_IDB_MARKER || url === SERVER_IMAGE_MARKER || url.startsWith(`${SERVER_IMAGE_MARKER}:`));

/**
 * A marker for a picture loaded by id: one stored on this device, or a versioned one on the server. Unlike
 * isImageMarker, not the bare 'server:has_image' of old records, which names no version to load.
 */
export const isLazyImageMarker = (url: string | undefined): boolean =>
  url === IMAGE_IDB_MARKER || getServerImageVersion(url) !== undefined;

/** The pictures a card shows: its own, and those of the words inside a phrase. */
export const picturesOf = (item: StoredItem): Array<{ id: string; imageUrl: string | undefined }> => [
  { id: item.data.id, imageUrl: item.data.imageUrl },
  ...(isPhraseItem(item) ? (item.data.vocabs ?? []).map(vocab => ({ id: vocab.id, imageUrl: vocab.imageUrl })) : []),
];

/**
 * `item` with each inline picture (a data URI) replaced by IMAGE_IDB_MARKER, and those pictures with the ids they
 * are stored under: the card's own under `topLevelId` (its id unless the caller saves it under another), each of a
 * phrase's words under its own id. A sentence keeps its picture. Returns the same item when it has none.
 */
export function extractInlineImages(
  item: StoredItem,
  topLevelId: string = item.data.id,
): { item: StoredItem; images: InlineImage[] } {
  const images: InlineImage[] = [];
  let changed = false;
  let data = item.data;

  // Vocab item image
  if (isVocabItem(item)) {
    const vc = data as VocabCard;
    if (vc.imageUrl?.startsWith('data:image/')) {
      images.push({ id: topLevelId, base64: vc.imageUrl });
      data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
      changed = true;
    }
  }

  // Phrase item image + nested vocab images
  if (isPhraseItem(item)) {
    const sr = data as SearchResult;
    if (sr.imageUrl?.startsWith('data:image/')) {
      images.push({ id: topLevelId, base64: sr.imageUrl });
      data = { ...data, imageUrl: IMAGE_IDB_MARKER } as SearchResult;
      changed = true;
    }
    if (sr.vocabs?.length) {
      let vocabsChanged = false;
      const newVocabs = sr.vocabs.map(v => {
        if (v.imageUrl?.startsWith('data:image/')) {
          images.push({ id: v.id, base64: v.imageUrl });
          vocabsChanged = true;
          return { ...v, imageUrl: IMAGE_IDB_MARKER };
        }
        return v;
      });
      if (vocabsChanged) {
        data = { ...data, vocabs: newVocabs } as SearchResult;
        changed = true;
      }
    }
  }

  return { item: changed ? { ...item, data } : item, images };
}

/**
 * Strip base64 imageUrl fields from items and store them in IDB images store.
 * Versioned server markers stay in state so OfflineImage can invalidate an older IDB entry.
 * Replaces base64 with a tiny marker so layout checks (imageUrl truthy) still work.
 * This keeps ~143MB of image data out of React state.
 * Waits for the device's copy, never the network. Throws when the pictures couldn't be stored, since markers would
 * then point at nothing here: the caller keeps the items inline and the next launch tries again.
 */
export async function stripAndStoreImages(items: StoredItem[], userId?: string): Promise<StoredItem[]> {
  const imagesToSave: InlineImage[] = [];

  const stripped = items.map(item => {
    const extracted = extractInlineImages(item);
    imagesToSave.push(...extracted.images);
    return extracted.item;
  });

  if (imagesToSave.length > 0) {
    log(`🖼️ Offloading ${imagesToSave.length} images to IDB + server`);
    const { stored } = await offloadImages(imagesToSave, userId);
    if (!stored) throw new Error('The pictures could not be stored on this device');
  }

  return stripped;
}

/** Puts images back inline where their offload failed, so no marker points at an image that was never stored. */
export function restoreInlineImages(item: StoredItem, images: ReadonlyMap<string, string>): StoredItem {
  const inline = <T extends { id: string; imageUrl?: string }>(card: T): T =>
    card.imageUrl === IMAGE_IDB_MARKER && images.has(card.id) ? { ...card, imageUrl: images.get(card.id) } : card;
  let data = inline(item.data);
  if (isPhraseItem(item) && item.data.vocabs?.length) {
    const vocabs = item.data.vocabs.map(inline);
    if (vocabs.some((vocab, index) => vocab !== item.data.vocabs[index])) data = { ...data, vocabs } as SearchResult;
  }
  return data === item.data ? item : { ...item, data } as StoredItem;
}
