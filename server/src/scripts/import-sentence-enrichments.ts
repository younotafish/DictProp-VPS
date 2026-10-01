import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import {
  db,
  getSentenceEnrichmentCount,
  upsertSentenceEnrichment,
  type SentenceEnrichmentImportRecord,
} from '../db.js';
import { detectImageMimeType } from '../image-format.js';
import { backupBeforeWrite, checkpointAfterWrite } from '../import-support.js';
import {
  validateSentenceEnrichmentBundle,
  type SentenceEnrichmentBundle,
} from '../sentence-enrichment.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-sentence-enrichments <manifest.json>');

const resolvedManifest = resolve(manifestPath);
const bundle = JSON.parse(readFileSync(resolvedManifest, 'utf8')) as SentenceEnrichmentBundle;
const validationError = validateSentenceEnrichmentBundle(bundle);
if (validationError) throw new Error(validationError);

function readBundleImage(path: string): { image: Buffer; mimeType: string } | { error: string } {
  let image: Buffer;
  try {
    image = readFileSync(path);
  } catch (error) {
    return { error: `image is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  if (image.length === 0 || image.length > 10 * 1024 * 1024) return { error: 'image size is invalid' };
  const mimeType = detectImageMimeType(image);
  return mimeType ? { image, mimeType } : { error: 'image format is invalid' };
}

const bundleRoot = dirname(resolvedManifest);
const prepared: SentenceEnrichmentImportRecord[] = [];
// A bad image costs only itself: its sentence's analysis still imports, and an image the sentence already
// has stays. A path outside the bundle is a broken bundle, though, and stops the import.
const imageErrors: Array<{ id: string; error: string }> = [];
for (const entry of bundle.entries) {
  if (!entry.imageFile) {
    prepared.push({ entry });
    continue;
  }
  const imagePath = resolve(bundleRoot, entry.imageFile);
  if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error(`${entry.id}: image path escapes bundle root`);
  const image = readBundleImage(imagePath);
  if ('error' in image) {
    imageErrors.push({ id: entry.id, error: image.error });
    prepared.push({ entry });
    continue;
  }
  prepared.push({ entry, ...image });
}

const backup = await backupBeforeWrite('sentence-enrichments');
const result = {
  total: prepared.length,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  stale: 0,
  imageBlobsAdded: 0,
  imagesSkipped: imageErrors.length,
  imageErrors: imageErrors.slice(0, 50),
  before: getSentenceEnrichmentCount(),
  after: 0,
};

db.transaction((records: SentenceEnrichmentImportRecord[]) => {
  for (const record of records) {
    const imported = upsertSentenceEnrichment(record);
    result[imported.status]++;
    if (imported.imageStored) result.imageBlobsAdded++;
  }
})(prepared);

result.after = getSentenceEnrichmentCount();
checkpointAfterWrite();
process.stdout.write(`${JSON.stringify({ ...result, backup })}\n`);
