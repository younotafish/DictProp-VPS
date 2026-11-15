import { dataUriToBlob } from '../dataUri';
import { requestJson } from '../http';
import { publishServerMutation } from '../syncSignals';

// Item pictures on the server: downloads by id, the list of ids it holds, and uploads.

/**
 * Fetch a single item's image file via the binary image endpoint.
 * - 404 → null: the item genuinely has no image (callers should NOT retry).
 * - network error / 5xx → throws: a transient failure (callers MAY retry).
 * This distinction lets OfflineImage retry flaky downloads instead of giving up on the first miss.
 */
export const loadItemImage = async (itemId: string, imageVersion?: string): Promise<Blob | null> => {
  const versionQuery = imageVersion ? `?v=${encodeURIComponent(imageVersion)}` : '';
  const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/image${versionQuery}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
  return res.blob();
};

/** Fetch the image files of several items, four at a time. Items without one are omitted. */
export const loadItemImagesBatch = async (
  ids: string[],
  imageVersions?: ReadonlyMap<string, string>,
): Promise<Map<string, Blob>> => {
  const result = new Map<string, Blob>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const image = await loadItemImage(id, imageVersions?.get(id));
        if (image) result.set(id, image);
      } catch { /* a later prefetch can retry transient failures */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return result;
};

/**
 * Fetch the set of image ids the server currently has stored (item + vocab ids).
 * Used by the recovery action to compute which local images are missing on the server.
 */
export const getServerImageManifest = async (): Promise<Set<string>> => {
  const ids = await requestJson<unknown>(
    '/api/items/images/manifest',
    undefined,
    'Load image manifest',
  );
  return new Set(Array.isArray(ids) ? ids : []);
};

/**
 * Uploads pictures (files or data URIs) to the server, one request each, in order: a new picture's upload and the
 * recovery action. Throws at the first that fails; the ones before it are stored.
 */
export const uploadImages = async (images: Record<string, Blob | string>): Promise<void> => {
  let saved = 0;
  for (const [id, image] of Object.entries(images)) {
    const blob = typeof image === 'string' ? dataUriToBlob(image) : image;
    const response = await fetch(`/api/items/${encodeURIComponent(id)}/image`, {
      method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob,
    });
    if (!response.ok) throw new Error(`Upload image failed (${response.status})`);
    saved++;
  }
  // Each upload bumps the revision of the items showing the image, so other tabs pull the new marker.
  if (saved > 0) publishServerMutation();
};
