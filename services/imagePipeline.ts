import { uploadImages } from './api/images';
import { dataUriToBlob } from './dataUri';
import { optimizeImages } from './imageProcessing';
import { readStoredImages, saveImagesBatch } from './imageStore';
import { addPendingImageUploads, readPendingImageUploads, removePendingImageUploads } from './imageUploadQueue';
import { warn } from './logger';
import { imageVersionFromContentHash, type InlineImage } from './libraryImages';
import { sha256Hex } from './sha256';

/** An optimized picture as the file that is stored and uploaded, under the id it belongs to. */
interface Picture {
  id: string;
  blob: Blob;
  /** The version the server will give these bytes. */
  version?: string;
}

/**
 * The version the server gives a picture with these bytes once it is uploaded. Stored under it, the device's copy
 * already matches the marker the next pull brings, so the picture isn't downloaded again. Without WebCrypto (an
 * insecure origin) the picture is stored unversioned, as before.
 */
async function serverVersionOf(blob: Blob): Promise<string | undefined> {
  try {
    return imageVersionFromContentHash(await sha256Hex(await blob.arrayBuffer()));
  } catch {
    return undefined;
  }
}

// A failed upload is tried once more after a short pause; one that fails again waits for a later run.
const UPLOAD_ATTEMPTS = 2;
const UPLOAD_RETRY_DELAY_MS = 800;

/**
 * Uploads each picture on its own, so a failure never sends again the pictures that went up: each upload bumps
 * the revision of the items showing it. Never rejects; resolves to the ids that still failed.
 */
async function uploadEach(pictures: ReadonlyArray<{ id: string; image: Blob | string }>): Promise<string[]> {
  const failed: string[] = [];
  for (const { id, image } of pictures) {
    for (let attempt = 1; ; attempt++) {
      try {
        await uploadImages({ [id]: image });
        break;
      } catch (error) {
        if (attempt >= UPLOAD_ATTEMPTS) {
          warn('Image upload failed; it waits for a later try', error);
          failed.push(id);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
      }
    }
  }
  return failed;
}

/** What an offload did: whether this device holds the pictures, and their upload. */
export interface Offload {
  /** The pictures are in IndexedDB, so they outlast a reload even if their upload fails. */
  stored: boolean;
  /** The upload under way, which never rejects: the ids whose upload failed after retrying. */
  uploaded: Promise<string[]>;
}

/**
 * Optimizes pictures, stores them on this device and starts their upload, resolving as soon as they are stored or
 * couldn't be, never waiting on the network. With a user id, a picture stored here whose upload fails is listed for
 * uploadPendingImages; one this device couldn't store is the caller's to keep inline.
 */
export async function offloadAndUpload(images: InlineImage[], userId?: string): Promise<Offload> {
  if (images.length === 0) return { stored: true, uploaded: Promise.resolve([]) };
  // One file per picture: the device stores the same bytes the server receives, under the version it will give them.
  const pictures: Picture[] = await Promise.all((await optimizeImages(images)).map(async ({ id, base64 }) => {
    const blob = dataUriToBlob(base64);
    return { id, blob, version: await serverVersionOf(blob) };
  }));
  const stored = await saveImagesBatch(pictures.map(({ id, blob, version }) => ({ id, image: blob, version })));
  const uploaded = uploadEach(pictures.map(({ id, blob }) => ({ id, image: blob }))).then(failed => {
    if (stored && userId) addPendingImageUploads(userId, failed);
    return failed;
  });
  return { stored, uploaded };
}

/**
 * Uploads the pictures listed after a failed upload. Those that go up come off the list, and so do those no longer
 * on this device; when IndexedDB can't be read, the list stays as it is.
 */
export async function uploadPendingImages(userId: string): Promise<void> {
  const ids = readPendingImageUploads(userId);
  if (ids.length === 0) return;
  const { images, complete } = await readStoredImages(ids);
  const failed = new Set(await uploadEach([...images].map(([id, image]) => ({ id, image }))));
  removePendingImageUploads(userId, ids.filter(id => !failed.has(id) && (images.has(id) || complete)));
}
