import { StoredItem } from '../types';

// Content hashing for dirty tracking. Stored lastSyncedHash values depend on this exact output, so
// changing the hash marks every item dirty and re-uploads the library.

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

// Strip image markers/base64 from data before hashing so that
// items with 'idb:stored' or 'server:has_image' don't hash differently from
// items with real base64 or no image at all.
const stripImageForHash = (data: any): any => {
  if (!data) return data;
  const cleaned = { ...data };
  if (cleaned.imageUrl && !cleaned.imageUrl.startsWith('http')) {
    delete cleaned.imageUrl;
  }
  if (Array.isArray(cleaned.vocabs)) {
    cleaned.vocabs = cleaned.vocabs.map((v: any) => {
      if (v?.imageUrl && !v.imageUrl.startsWith('http')) {
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
    isDeleted: item.isDeleted,
    isArchived: item.isArchived,
  };

  const hash = hashString(JSON.stringify(contentToHash));
  hashCache.set(item, hash);
  return hash;
};

/** True when the item differs from the content the server last acknowledged. */
export const isItemDirty = (item: StoredItem): boolean => getItemContentHash(item) !== item.lastSyncedHash;
