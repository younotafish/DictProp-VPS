/** Convert a data URI to a Blob without issuing a fetch request. */
export function dataUriToBlob(dataUri: string): Blob {
  if (!dataUri.startsWith('data:')) throw new Error('Invalid data URI');

  const comma = dataUri.indexOf(',');
  if (comma < 5) throw new Error('Invalid data URI');

  const metadata = dataUri.slice(5, comma).split(';');
  const mimeType = metadata[0] || 'application/octet-stream';
  const payload = dataUri.slice(comma + 1);

  if (metadata.slice(1).some(part => part.toLowerCase() === 'base64')) {
    const binary = atob(payload.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([new TextEncoder().encode(decodeURIComponent(payload))], { type: mimeType });
}

// String.fromCharCode takes the bytes as arguments, so they go in chunks well under every engine's argument limit.
const BASE64_CHUNK = 0x8000;

/** Base64 of `bytes`: what btoa gives for their binary string, built a chunk at a time rather than a byte at a time. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }
  return btoa(binary);
}
