import { StoredItem } from '../types';

// Content hashing for dirty tracking. Stored lastSyncedHash values depend on this exact output, so
// changing the hash marks every item dirty and re-uploads the library.

/**
 * Version of the hash output. Local records store their hash with it; bump it when the output changes.
 * Version 1 also hashed false flags and http image URLs. Not bumped for dropping them: a stale stored hash
 * of such an item only costs one more upload, while a bump would rehash and rewrite every local record.
 */
export const ITEM_HASH_VERSION = 1;

const hashString = (str: string): string => {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 << 5) + h1) + c;
    h1 = h1 & h1;
    h2 = ((h2 << 5) + h2) + c;
    h2 = h2 & h2;
  }
  return Math.abs(h1).toString(36) + Math.abs(h2).toString(36);
};

// Items are replaced rather than mutated, so a hash stays valid for the object it was computed from.
const hashCache = new WeakMap<StoredItem, string>();

// The server keeps images out of item data (it stores base64 separately and drops every other imageUrl),
// so an imageUrl (a marker or a URL) is never content: hashing one would leave the item dirty after every echo.
const stripImageForHash = (data: any): any => {
  if (!data) return data;
  const cleaned = { ...data };
  delete cleaned.imageUrl;
  if (Array.isArray(cleaned.vocabs)) {
    cleaned.vocabs = cleaned.vocabs.map((v: any) => {
      if (v && typeof v === 'object' && 'imageUrl' in v) {
        const { imageUrl, ...rest } = v;
        return rest;
      }
      return v;
    });
  }
  return cleaned;
};

export const getItemContentHash = (item: StoredItem): string => {
  const cached = hashCache.get(item);
  if (cached) return cached;

  const contentToHash = {
    type: item.type,
    data: stripImageForHash(item.data),
    srs: item.srs,
    // The server echoes a cleared flag as absent, so false and undefined must hash alike.
    isDeleted: item.isDeleted || undefined,
    isArchived: item.isArchived || undefined,
  };

  const hash = hashString(JSON.stringify(contentToHash));
  hashCache.set(item, hash);
  return hash;
};

/** Records a hash computed earlier for the same content, such as one stored with a local record. */
export const seedItemContentHash = (item: StoredItem, hash: string): void => {
  if (!hashCache.has(item)) hashCache.set(item, hash);
};

/** True when the item differs from the content the server last acknowledged. */
export const isItemDirty = (item: StoredItem): boolean => getItemContentHash(item) !== item.lastSyncedHash;
