// Item JSON never carries image bytes. Where a stored image is, the server sends this marker followed by the
// image's content version (`server:has_image:<version>`), so a device can tell that its cached copy is older.

export const SERVER_IMAGE_MARKER = 'server:has_image';

export const serverImageMarker = (version: string): string => `${SERVER_IMAGE_MARKER}:${version}`;

/**
 * The content version of an image: the first 20 hex digits of the SHA-256 of its bytes. The server marks a stored image
 * with it, and a device that uploads a picture stores its copy under it before the server announces it.
 */
export const imageVersionFromContentHash = (sha256Hex: string): string => sha256Hex.slice(0, 20);

/** The content version a marker names, or undefined for anything that isn't a versioned server marker. */
export const getServerImageVersion = (url: string | undefined): string | undefined =>
  url?.startsWith(`${SERVER_IMAGE_MARKER}:`)
    ? url.slice(SERVER_IMAGE_MARKER.length + 1)
    : undefined;
