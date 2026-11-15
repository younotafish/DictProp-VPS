import { uploadImages } from './api';
import { optimizeImages } from './imageProcessing';
import { saveImagesBatch } from './imageStore';
import { warn } from './logger';
import type { InlineImage } from './libraryImages';

async function uploadWithRetry(images: InlineImage[]): Promise<void> {
  const chunkSize = 8;
  for (let i = 0; i < images.length; i += chunkSize) {
    const chunk = images.slice(i, i + chunkSize);
    const payload = Object.fromEntries(chunk.map(image => [image.id, image.base64]));
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
  const optimized = await optimizeImages(images);
  await saveImagesBatch(optimized.map(({ id, base64 }) => ({ id, image: base64 })));
  void uploadWithRetry(optimized);
}
