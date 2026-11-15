import {
  db,
  getSentenceEnrichmentCount,
  upsertSentenceEnrichment,
  type SentenceEnrichmentImportRecord,
} from '../db.js';
import { backupBeforeWrite } from '../import-support.js';
import {
  validateSentenceEnrichmentBundle,
  type SentenceEnrichmentBundle,
} from '../sentence-enrichment.js';
import { BundleImageError, readBundleImage, readBundleManifest, resolveInBundle } from './support/bundle.js';
import { finishImport } from './support/run.js';

const { bundle, bundleRoot } = readBundleManifest<SentenceEnrichmentBundle>(
  'Usage: import-sentence-enrichments <manifest.json>',
  validateSentenceEnrichmentBundle,
);

const prepared: SentenceEnrichmentImportRecord[] = [];
// A bad image costs only itself: its sentence's analysis still imports, and an image the sentence already
// has stays. A path outside the bundle is a broken bundle, though, and stops the import.
const imageErrors: Array<{ id: string; error: string }> = [];
for (const entry of bundle.entries) {
  if (!entry.imageFile) {
    prepared.push({ entry });
    continue;
  }
  const imagePath = resolveInBundle(bundleRoot, entry.imageFile);
  if (!imagePath) throw new Error(`${entry.id}: image path escapes bundle root`);
  try {
    prepared.push({ entry, ...readBundleImage(imagePath) });
  } catch (error) {
    const reason = error instanceof BundleImageError
      ? error.message
      : `image is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    imageErrors.push({ id: entry.id, error: reason });
    prepared.push({ entry });
  }
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
// The report has no errors field: a skipped image is in imageErrors, and its analysis imported, so the run succeeds.
finishImport(result, backup);
