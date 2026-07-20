import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import {
  db,
  getSentenceEnrichmentCount,
  upsertSentenceEnrichment,
  type SentenceEnrichmentImportRecord,
} from '../db.js';
import { detectImageMimeType } from '../image-format.js';
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

const bundleRoot = dirname(resolvedManifest);
const prepared: SentenceEnrichmentImportRecord[] = [];
for (const entry of bundle.entries) {
  if (!entry.imageFile) {
    prepared.push({ entry });
    continue;
  }
  const imagePath = resolve(bundleRoot, entry.imageFile);
  if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error(`${entry.id}: image path escapes bundle root`);
  const image = readFileSync(imagePath);
  if (image.length === 0 || image.length > 10 * 1024 * 1024) throw new Error(`${entry.id}: image size is invalid`);
  const mimeType = detectImageMimeType(image);
  if (!mimeType) throw new Error(`${entry.id}: image format is invalid`);
  prepared.push({ entry, image, mimeType });
}

const result = {
  total: prepared.length,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  stale: 0,
  imageBlobsAdded: 0,
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
process.stdout.write(`${JSON.stringify(result)}\n`);
