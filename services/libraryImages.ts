import { isPhraseItem, isVocabItem, type SearchResult, type StoredItem, type VocabCard } from '../types';
import { loadItemImage } from './api';
import { log } from './logger';
import { saveImage } from './storage';

// Pictures stay out of the library in memory: each card carries a marker, and the picture lives in
// IndexedDB and on the server.

export const offloadImages = async (images: Array<{ id: string; base64: string }>): Promise<void> => {
  const { offloadAndUpload } = await import('./imagePipeline');
  await offloadAndUpload(images);
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

// Check if an imageUrl is a marker (not real base64 data)
export const isImageMarker = (url: string | undefined): boolean =>
  !!url && (url === IMAGE_IDB_MARKER || url === SERVER_IMAGE_MARKER || url.startsWith(`${SERVER_IMAGE_MARKER}:`));

/**
 * Strip base64 imageUrl fields from items and store them in IDB images store.
 * Versioned server markers stay in state so OfflineImage can invalidate an older IDB entry.
 * Replaces base64 with a tiny marker so layout checks (imageUrl truthy) still work.
 * This keeps ~143MB of image data out of React state.
 */
export async function stripAndStoreImages(items: StoredItem[]): Promise<StoredItem[]> {
  const imagesToSave: Array<{ id: string; base64: string }> = [];

  const stripped = items.map(item => {
    let changed = false;
    let data = item.data;

    // Vocab item image
    if (isVocabItem(item)) {
      const vc = data as VocabCard;
      if (vc.imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: data.id, base64: vc.imageUrl });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as VocabCard;
        changed = true;
      }
    }

    // Phrase item image + nested vocab images
    if (isPhraseItem(item)) {
      const sr = data as SearchResult;
      if (sr.imageUrl?.startsWith('data:image/')) {
        imagesToSave.push({ id: sr.id, base64: sr.imageUrl });
        data = { ...data, imageUrl: IMAGE_IDB_MARKER } as SearchResult;
        changed = true;
      }
      if (sr.vocabs?.length) {
        let vocabsChanged = false;
        const newVocabs = sr.vocabs.map(v => {
          if (v.imageUrl?.startsWith('data:image/')) {
            imagesToSave.push({ id: v.id, base64: v.imageUrl });
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

    return changed ? { ...item, data } : item;
  });

  if (imagesToSave.length > 0) {
    log(`🖼️ Offloading ${imagesToSave.length} images to IDB + server`);
    await offloadImages(imagesToSave);
  }

  return stripped;
}

/** Puts images back inline where their offload failed, so no marker points at an image that was never stored. */
export function restoreInlineImages(item: StoredItem, images: ReadonlyMap<string, string>): StoredItem {
  const inline = <T extends { id: string; imageUrl?: string }>(card: T): T =>
    card.imageUrl === IMAGE_IDB_MARKER && images.has(card.id) ? { ...card, imageUrl: images.get(card.id) } : card;
  let data = inline(item.data);
  if (isPhraseItem(item) && item.data.vocabs?.length) {
    data = { ...data, vocabs: item.data.vocabs.map(inline) } as SearchResult;
  }
  return data === item.data ? item : { ...item, data } as StoredItem;
}
