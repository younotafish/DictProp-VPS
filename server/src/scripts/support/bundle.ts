// Reading an import bundle: its manifest and the files beside it. Nothing here opens the database, so an importer
// that never writes it (the TTS one) can use this without running db.ts's schema setup.
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { detectImageMimeType } from '../../image-format.js';

/** The largest image a bundle may carry. */
export const MAX_BUNDLE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The manifest the script's first argument names, parsed and validated, and the folder its files sit in. Throws
 * `usage` when there is no argument and the validator's message when the manifest fails it.
 */
export function readBundleManifest<T>(
  usage: string,
  validate: (value: unknown) => string | null,
): { bundle: T; bundleRoot: string } {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error(usage);
  const resolvedManifest = resolve(manifestPath);
  const bundle = JSON.parse(readFileSync(resolvedManifest, 'utf8')) as T;
  const validationError = validate(bundle);
  if (validationError) throw new Error(validationError);
  return { bundle, bundleRoot: dirname(resolvedManifest) };
}

/**
 * The absolute path of a file in the bundle, or null when the relative path leads out of it. The validators already
 * restrict bundle paths; this is the second guard, and the only one, so tighten it here.
 */
export function resolveInBundle(bundleRoot: string, relativePath: string): string | null {
  const path = resolve(bundleRoot, relativePath);
  return path.startsWith(`${bundleRoot}${sep}`) ? path : null;
}

/** A bundle image that is empty, too large, or in a format the server doesn't store. */
export class BundleImageError extends Error {}

/**
 * A bundle image's bytes and type. A missing or unreadable file throws fs's own error; an empty, oversized or
 * unrecognized one throws BundleImageError.
 */
export function readBundleImage(path: string): { image: Buffer; mimeType: string } {
  const image = readFileSync(path);
  if (image.length === 0 || image.length > MAX_BUNDLE_IMAGE_BYTES) throw new BundleImageError('image size is invalid');
  const mimeType = detectImageMimeType(image);
  if (!mimeType) throw new BundleImageError('image format is invalid');
  return { image, mimeType };
}

/** How an import reports a failed entry: the error's message, or the thrown value itself. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
