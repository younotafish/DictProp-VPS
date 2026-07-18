import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { corpusSourceHash } from '../corpus-audit.js';
import { getItemById, listAllUsers, upsertItemImageBinary } from '../db.js';
import { env } from '../env.js';
import { detectImageMimeType } from '../image-format.js';
import { validateOfflineImageBundle, type OfflineImageBundle } from '../offline-image-import.js';
import { isOwnerUser } from '../owner-access.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-offline-images <manifest.json>');

const resolvedManifest = resolve(manifestPath);
const bundle = JSON.parse(readFileSync(resolvedManifest, 'utf8')) as OfflineImageBundle;
const validationError = validateOfflineImageBundle(bundle);
if (validationError) throw new Error(validationError);

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const bundleRoot = dirname(resolvedManifest);
const result = { total: bundle.entries.length, replaced: 0, skipped: 0, errors: [] as Array<{ id: string; error: string }> };

for (const entry of bundle.entries) {
  try {
    const parent = getItemById(entry.parentId, owner.id, false) as any;
    if (!parent || parent.isDeleted) throw new Error('parent item is missing or deleted');
    if (corpusSourceHash(parent.data) !== entry.parentHash) throw new Error('parent content changed after generation');
    const validImageIds = new Set([
      parent.data.id,
      ...(Array.isArray(parent.data.vocabs) ? parent.data.vocabs.map((vocab: any) => vocab?.id) : []),
    ]);
    if (!validImageIds.has(entry.imageId)) throw new Error('image id does not belong to parent item');

    const imagePath = resolve(bundleRoot, entry.imageFile);
    if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error('image path escapes bundle root');
    const image = readFileSync(imagePath);
    if (image.length === 0 || image.length > 10 * 1024 * 1024) throw new Error('image size is invalid');
    const mimeType = detectImageMimeType(image);
    if (!mimeType) throw new Error('image format is invalid');
    if (!upsertItemImageBinary(entry.imageId, image, mimeType, owner.id)) throw new Error('image could not be stored');
    result.replaced++;
  } catch (error) {
    result.skipped++;
    result.errors.push({ id: entry.imageId, error: error instanceof Error ? error.message : String(error) });
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
