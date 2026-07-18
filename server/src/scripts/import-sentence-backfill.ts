import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import {
  getImageManifest,
  getItemById,
  listAllUsers,
  upsertItem,
  upsertItemImageBinary,
} from '../db.js';
import { env } from '../env.js';
import { detectImageMimeType } from '../image-format.js';
import { isOwnerUser } from '../owner-access.js';
import {
  validateSentenceBackfillBundle,
  type SentenceBackfillBundle,
} from '../sentence-backfill.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-sentence-backfill <manifest.json>');

const resolvedManifest = resolve(manifestPath);
const bundle = JSON.parse(readFileSync(resolvedManifest, 'utf8')) as SentenceBackfillBundle;
const validationError = validateSentenceBackfillBundle(bundle);
if (validationError) throw new Error(validationError);

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const bundleRoot = dirname(resolvedManifest);
const imageIds = new Set(getImageManifest(owner.id));
const result = {
  total: bundle.entries.length,
  analysesUpdated: 0,
  imagesAdded: 0,
  imagesPreserved: 0,
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};

for (const entry of bundle.entries) {
  try {
    const item = getItemById(entry.id, owner.id, false) as any;
    if (!item || item.type !== 'sentence' || item.isDeleted) {
      result.skipped++;
      result.errors.push({ id: entry.id, error: 'sentence is missing or deleted' });
      continue;
    }
    const currentText = typeof item.data?.text === 'string' ? item.data.text : '';
    const currentHash = createHash('sha256').update(currentText).digest('hex');
    if (currentHash !== entry.textHash) {
      result.skipped++;
      result.errors.push({ id: entry.id, error: 'sentence text changed after export' });
      continue;
    }

    const updatedAt = Math.max(Date.now(), Number(item.updatedAt || 0) + 1);
    upsertItem({
      ...item,
      data: {
        ...item.data,
        analysis: entry.analysis,
        analysisGeneratedAt: entry.generatedAt,
      },
      updatedAt,
    }, owner.id);
    result.analysesUpdated++;

    if (!entry.imageFile) continue;
    if (imageIds.has(entry.id)) {
      result.imagesPreserved++;
      continue;
    }
    const imagePath = resolve(bundleRoot, entry.imageFile);
    if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error('image path escapes bundle root');
    const image = readFileSync(imagePath);
    if (image.length === 0 || image.length > 10 * 1024 * 1024) throw new Error('image size is invalid');
    const mimeType = detectImageMimeType(image);
    if (!mimeType) throw new Error('image format is invalid');
    if (!upsertItemImageBinary(entry.id, image, mimeType, owner.id)) throw new Error('image could not be stored');
    imageIds.add(entry.id);
    result.imagesAdded++;
  } catch (error) {
    result.errors.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
