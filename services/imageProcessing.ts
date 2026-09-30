import { dataUriToBlob } from './dataUri';

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 960;
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;

/**
 * Resize oversized images before IDB/network persistence and normalize them to WebP (JPEG where the
 * browser can't encode WebP), unless that wouldn't make a small JPEG/PNG/WebP any smaller.
 */
export async function optimizeImageDataUri(dataUri: string): Promise<string> {
  if (!dataUri.startsWith('data:image/')) return dataUri;
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    const source = dataUriToBlob(dataUri);
    bitmap = await createImageBitmap(source);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return dataUri;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let optimized = canvas.toDataURL('image/webp', WEBP_QUALITY);
    // Browsers that can't encode WebP (older Safari) hand back a PNG instead, often several times the
    // size of the photo it came from; a JPEG is the compact choice for an opaque canvas like this one.
    if (!optimized.startsWith('data:image/webp')) optimized = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    // An image that needed no resizing, in a format the server takes, stays as it came unless this shrank it.
    const keepable = scale === 1 &&/^data:image\/(?:jpeg|png|webp)[;,]/.test(dataUri);
    return keepable && optimized.length >= dataUri.length ? dataUri : optimized;
  } catch {
    return dataUri;
  } finally {
    bitmap?.close();
    // Hand the canvas memory back now: iOS caps the total, and a detached canvas holds it until collected.
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/** One at a time, so a batch of large photos is never decoded into memory all at once. */
export async function optimizeImages(images: Array<{ id: string; base64: string }>) {
  const optimized: Array<{ id: string; base64: string }> = [];
  for (const image of images) {
    optimized.push({ id: image.id, base64: await optimizeImageDataUri(image.base64) });
  }
  return optimized;
}
