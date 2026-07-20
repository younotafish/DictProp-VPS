import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { corpusSourceHash } from '../corpus-audit.js';
import { db, getAllItems, listAllUsers, upsertItem, upsertItemImageBinary } from '../db.js';
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
const parentById = new Map(getAllItems(true, owner.id).map(item => [item.data.id, item]));
const touchedParentIds = new Set<string>();
const result = { total: bundle.entries.length, replaced: 0, skipped: 0, errors: [] as Array<{ id: string; error: string }> };

type PreparedEntry = {
  entry: OfflineImageBundle['entries'][number];
  image: Buffer;
  mimeType: string;
};
const prepared: PreparedEntry[] = [];

// Read and validate every file before taking SQLite's write lock. Applying the prepared wave in a
// single transaction avoids one durable commit per statement on the resource-constrained VPS.
for (const entry of bundle.entries) {
  try {
    const parent = parentById.get(entry.parentId) as any;
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
    prepared.push({ entry, image, mimeType });
  } catch (error) {
    result.skipped++;
    result.errors.push({ id: entry.imageId, error: error instanceof Error ? error.message : String(error) });
  }
}

const applyPrepared = db.transaction((entries: PreparedEntry[]) => {
  for (const { entry, image, mimeType } of entries) {
    try {
      if (!upsertItemImageBinary(entry.imageId, image, mimeType, owner.id)) throw new Error('image could not be stored');
      touchedParentIds.add(entry.parentId);
      result.replaced++;
    } catch (error) {
      result.skipped++;
      result.errors.push({ id: entry.imageId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Image bytes live outside the item JSON. Bump each affected parent once so revision-delta clients
  // receive the new content-hash marker and invalidate any older IndexedDB image.
  for (const parentId of touchedParentIds) {
    const parent = parentById.get(parentId) as any;
    if (!parent) continue;
    try {
      upsertItem({
        ...parent,
        updatedAt: Math.max(Date.now(), Number(parent.updatedAt || 0) + 1),
      }, owner.id);
    } catch (error) {
      result.errors.push({
        id: parentId,
        error: `image revision could not be published: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
});
applyPrepared(prepared);

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
