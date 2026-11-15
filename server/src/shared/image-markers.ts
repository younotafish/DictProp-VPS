// Item JSON never carries image bytes. Where a stored image is, the server sends this marker followed by the
// image's content version (`server:has_image:<version>`), so a device can tell that its cached copy is older.

export const SERVER_IMAGE_MARKER = 'server:has_image';

export const serverImageMarker = (version: string): string => `${SERVER_IMAGE_MARKER}:${version}`;

/** The content version a marker names, or undefined for anything that isn't a versioned server marker. */
export const getServerImageVersion = (url: string | undefined): string | undefined =>
  url?.startsWith(`${SERVER_IMAGE_MARKER}:`)
    ? url.slice(SERVER_IMAGE_MARKER.length + 1)
    : undefined;
