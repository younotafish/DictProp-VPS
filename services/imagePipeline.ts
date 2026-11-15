import { uploadImages } from './api/images';
import { dataUriToBlob } from './dataUri';
import { optimizeImages } from './imageProcessing';
import { saveImagesBatch } from './imageStore';
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

async function uploadWithRetry(images: Picture[]): Promise<void> {
  const chunkSize = 8;
  for (let i = 0; i < images.length; i += chunkSize) {
    const chunk = images.slice(i, i + chunkSize);
    const payload = Object.fromEntries(chunk.map(image => [image.id, image.blob]));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await uploadImages(payload);
        break;
      } catch (error) {
        if (attempt === 1) warn('Image upload failed; recovery can retry later', error);
        else await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
}

export async function offloadAndUpload(images: InlineImage[]): Promise<void> {
  if (images.length === 0) return;
  // One file per picture: the device stores the same bytes the server receives, under the version it will give them.
  const pictures: Picture[] = await Promise.all((await optimizeImages(images)).map(async ({ id, base64 }) => {
    const blob = dataUriToBlob(base64);
    return { id, blob, version: await serverVersionOf(blob) };
  }));
  await saveImagesBatch(pictures.map(({ id, blob, version }) => ({ id, image: blob, version })));
  void uploadWithRetry(pictures);
}
