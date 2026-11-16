import { runPool } from '../../server/src/shared/pool';
import { dataUriToBlob } from '../dataUri';
import { fetchWithin, requestJson } from '../http';
import { publishServerMutation } from '../syncSignals';

// Item pictures on the server: downloads by id, the list of ids it holds, and uploads.

// fetch() never gives up on a stalled connection by itself, so a wedged mobile socket would hold a picture's spinner,
// and every view waiting on the same download, for minutes. A picture is at most 10 MB and usually a few hundred KB,
// so a minute leaves a slow link room; uploads go the slow direction on a phone, so they get two.
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const IMAGE_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Fetch a single item's image file via the binary image endpoint.
 * - 404 → null: the item genuinely has no image (callers should NOT retry).
 * - network error / 5xx / a stall past IMAGE_DOWNLOAD_TIMEOUT_MS → throws: a transient failure (callers MAY retry).
 * This distinction lets OfflineImage retry flaky downloads instead of giving up on the first miss.
 */
export const loadItemImage = async (itemId: string, imageVersion?: string): Promise<Blob | null> => {
  const versionQuery = imageVersion ? `?v=${encodeURIComponent(imageVersion)}` : '';
  const url = `/api/items/${encodeURIComponent(itemId)}/image${versionQuery}`;
  return fetchWithin(url, undefined, IMAGE_DOWNLOAD_TIMEOUT_MS, async (res) => {
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
    return res.blob();
  });
};

/**
 * Fetch the image files of several items, four at a time: `images` has the files downloaded, and `failed` the ids
 * whose download threw (no connection, a server error, a stall), which a later attempt may retry. An item the server
 * has no picture for (404) is in neither.
 */
export const loadItemImagesBatch = async (
  ids: string[],
  imageVersions?: ReadonlyMap<string, string>,
): Promise<{ images: Map<string, Blob>; failed: string[] }> => {
  const images = new Map<string, Blob>();
  const failed: string[] = [];
  await runPool(ids, 4, async (id) => {
    try {
      const image = await loadItemImage(id, imageVersions?.get(id));
      if (image) images.set(id, image);
    } catch {
      failed.push(id);
    }
  });
  return { images, failed };
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
    const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob };
    await fetchWithin(`/api/items/${encodeURIComponent(id)}/image`, init, IMAGE_UPLOAD_TIMEOUT_MS, async (response) => {
      if (!response.ok) throw new Error(`Upload image failed (${response.status})`);
    });
    saved++;
  }
  // Each upload bumps the revision of the items showing the image, so other tabs pull the new marker.
  if (saved > 0) publishServerMutation();
};
