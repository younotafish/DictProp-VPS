export type SupportedImageMime =
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export function detectImageMimeType(data: Uint8Array): SupportedImageMime | null {
  if (data.length >= 8 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6) {
    const signature = Buffer.from(data.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (data.length >= 12) {
    const prefix = Buffer.from(data.subarray(0, 4)).toString('ascii');
    const container = Buffer.from(data.subarray(8, 12)).toString('ascii');
    if (prefix === 'RIFF' && container === 'WEBP') return 'image/webp';

    const box = Buffer.from(data.subarray(4, 8)).toString('ascii');
    if (box === 'ftyp' && (container === 'avif' || container === 'avis')) return 'image/avif';
  }
  return null;
}

export function hasImageSignature(data: Uint8Array, mimeType: string): boolean {
  const normalized = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
  return detectImageMimeType(data) === normalized;
}
