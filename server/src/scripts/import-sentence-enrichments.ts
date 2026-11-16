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

const CHUNK_SIZE = 100;
const MAX_REPORTED_IMAGE_ERRORS = 50;

const { bundle, bundleRoot } = readBundleManifest<SentenceEnrichmentBundle>(
  'Usage: import-sentence-enrichments <manifest.json>',
  validateSentenceEnrichmentBundle,
);
type Entry = SentenceEnrichmentBundle['entries'][number];

// A path outside the bundle is a broken bundle, and stops the import before anything is written.
const imagePaths = bundle.entries.map(entry => {
  if (!entry.imageFile) return null;
  const imagePath = resolveInBundle(bundleRoot, entry.imageFile);
  if (!imagePath) throw new Error(`${entry.id}: image path escapes bundle root`);
  return imagePath;
});

const backup = await backupBeforeWrite('sentence-enrichments');
const result = {
  total: bundle.entries.length,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  stale: 0,
  imageBlobsAdded: 0,
  imagesSkipped: 0,
  imageErrors: [] as Array<{ id: string; error: string }>,
  before: getSentenceEnrichmentCount(),
  after: 0,
};

// A bad image costs only itself: its sentence's analysis still imports, and an image the sentence already has stays.
function prepare(entry: Entry, imagePath: string | null): SentenceEnrichmentImportRecord {
  if (!imagePath) return { entry };
  try {
    return { entry, ...readBundleImage(imagePath) };
  } catch (error) {
    result.imagesSkipped++;
    if (result.imageErrors.length < MAX_REPORTED_IMAGE_ERRORS) {
      const reason = error instanceof BundleImageError
        ? error.message
        : `image is unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
      result.imageErrors.push({ id: entry.id, error: reason });
    }
    return { entry };
  }
}

const applyChunk = db.transaction((records: SentenceEnrichmentImportRecord[]) =>
  records.map(record => upsertSentenceEnrichment(record)));

// Each chunk reads only its own images and commits on its own, taking the write lock before its first read, as the
// other importers do: a transaction that has read can't wait for a save the live app makes meanwhile, and would fail
// at once. A run that fails part way leaves its earlier chunks in place; the retry finds them unchanged.
for (let start = 0; start < bundle.entries.length; start += CHUNK_SIZE) {
  const records = bundle.entries.slice(start, start + CHUNK_SIZE)
    .map((entry, offset) => prepare(entry, imagePaths[start + offset]));
  for (const imported of applyChunk.immediate(records)) {
    result[imported.status]++;
    if (imported.blobAdded) result.imageBlobsAdded++;
  }
}

result.after = getSentenceEnrichmentCount();
// The report has no errors field: a skipped image is in imageErrors, and its analysis imported, so the run succeeds.
finishImport(result, backup);
