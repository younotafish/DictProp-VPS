const MAX_WIDTH = 1280;
const MAX_HEIGHT = 960;
const WEBP_QUALITY = 0.82;

/** Resize oversized images before IDB/network persistence and normalize them to WebP. */
export async function optimizeImageDataUri(dataUri: string): Promise<string> {
  if (!dataUri.startsWith('data:image/')) return dataUri;
  try {
    const source = await fetch(dataUri).then(response => response.blob());
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return dataUri;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/webp', WEBP_QUALITY);
  } catch {
    return dataUri;
  }
}

export async function optimizeImages(images: Array<{ id: string; base64: string }>) {
  return Promise.all(images.map(async image => ({
    id: image.id,
    base64: await optimizeImageDataUri(image.base64),
  })));
}
