import { uploadImages } from './api/images';
import { dataUriToBlob } from './dataUri';
import { optimizeImages } from './imageProcessing';
import { saveImagesBatch } from './imageStore';
import { warn } from './logger';
import type { InlineImage } from './libraryImages';

/** An optimized picture as the file that is stored and uploaded, under the id it belongs to. */
interface Picture {
  id: string;
  blob: Blob;
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
  // One file per picture: the device stores the same bytes the server receives.
  const pictures = (await optimizeImages(images)).map(({ id, base64 }) => ({ id, blob: dataUriToBlob(base64) }));
  await saveImagesBatch(pictures.map(({ id, blob }) => ({ id, image: blob })));
  void uploadWithRetry(pictures);
}
