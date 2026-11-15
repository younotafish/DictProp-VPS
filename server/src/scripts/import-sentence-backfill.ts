import { db, getItemById, hasItemImage, upsertItemImageBinary } from '../db.js';
import { backupBeforeWrite, recordStale, StaleEntryError, writeOverLiveItem } from '../import-support.js';
import {
  validateSentenceBackfillBundle,
  type SentenceBackfillBundle,
} from '../sentence-backfill.js';
import { sentenceTextHash } from '../sentence-lookup.js';
import { errorMessage, readBundleImage, readBundleManifest, resolveInBundle } from './support/bundle.js';
import { finishImport, requireOwner } from './support/run.js';

const { bundle, bundleRoot } = readBundleManifest<SentenceBackfillBundle>(
  'Usage: import-sentence-backfill <manifest.json>',
  validateSentenceBackfillBundle,
);
const owner = requireOwner();

const backup = await backupBeforeWrite('sentence-backfill');
const result = {
  total: bundle.entries.length,
  analysesUpdated: 0,
  imagesAdded: 0,
  imagesReplaced: 0,
  imagesPreserved: 0,
  stale: 0,
  staleIds: [] as string[],
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};

type Entry = SentenceBackfillBundle['entries'][number];
/** imageError: the bundle's image for the entry could not be read, or is not an image the server stores. */
type PreparedEntry = { entry: Entry; image: Buffer | null; mimeType: string | null; imageError?: string };
type Outcome = { id: string; image: 'added' | 'replaced' | 'preserved' | null; imageError?: string };

// Only images that will be written are read, and only for the current chunk.
const prepare = (entry: Entry): PreparedEntry => {
  if (!entry.imageFile || (entry.replaceImage !== true && hasItemImage(entry.id, owner.id))) {
    return { entry, image: null, mimeType: null };
  }
  const imagePath = resolveInBundle(bundleRoot, entry.imageFile);
  if (!imagePath) throw new Error('image path escapes bundle root');
  try {
    return { entry, ...readBundleImage(imagePath) };
  } catch (error) {
    return { entry, image: null, mimeType: null, imageError: errorMessage(error) };
  }
};

// A savepoint per sentence, checked against its live row: the analysis is written over what is stored
// now with the stored revision, and the image is stored only after that write went through cleanly.
const importSentence = db.transaction(({ entry, image, mimeType, imageError }: PreparedEntry): Outcome => {
  const live = getItemById(entry.id, owner.id, false) as any;
  if (!live || live.isDeleted) throw new StaleEntryError('sentence is missing or deleted');
  if (live.type !== 'sentence') throw new Error('item is no longer a sentence');
  const liveText = typeof live.data?.text === 'string' ? live.data.text : '';
  if (sentenceTextHash(liveText) !== entry.textHash) {
    throw new StaleEntryError('sentence text changed after export');
  }
  const imageExists = hasItemImage(entry.id, owner.id);
  if (entry.imageFile && !image && !imageError && !imageExists) {
    throw new StaleEntryError('image was removed while the backfill was imported');
  }
  writeOverLiveItem(live, owner.id, {
    ...live.data,
    analysis: entry.analysis,
    analysisGeneratedAt: entry.generatedAt,
  });

  if (!entry.imageFile) return { id: entry.id, image: null };
  // A bad or refused image leaves the new analysis in place, and any image already stored, and is reported on its own.
  if (imageError) return { id: entry.id, image: null, imageError };
  if (imageExists && entry.replaceImage !== true) return { id: entry.id, image: 'preserved' };
  if (!image || !mimeType || !upsertItemImageBinary(entry.id, image, mimeType, owner.id)) {
    return { id: entry.id, image: null, imageError: 'image could not be stored' };
  }
  return { id: entry.id, image: imageExists ? 'replaced' : 'added' };
});

const applyChunk = db.transaction((entries: PreparedEntry[]) => {
  const outcomes: Outcome[] = [];
  const stale: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const prepared of entries) {
    try {
      outcomes.push(importSentence(prepared));
    } catch (error) {
      if (error instanceof StaleEntryError) stale.push(prepared.entry.id);
      else failures.push({ id: prepared.entry.id, error: errorMessage(error) });
    }
  }
  return { outcomes, stale, failures };
});

const recordFailure = (failure: { id: string; error: string }) => {
  result.skipped++;
  result.errors.push(failure);
};

// Each chunk commits on its own, keeping the write lock short enough for the live app to keep saving.
for (let start = 0; start < bundle.entries.length; start += 100) {
  const prepared: PreparedEntry[] = [];
  for (const entry of bundle.entries.slice(start, start + 100)) {
    try {
      prepared.push(prepare(entry));
    } catch (error) {
      recordFailure({ id: entry.id, error: errorMessage(error) });
    }
  }
  if (prepared.length === 0) continue;
  try {
    const { outcomes, stale, failures } = applyChunk.immediate(prepared);
    // Counted only once committed.
    for (const outcome of outcomes) {
      result.analysesUpdated++;
      if (outcome.image === 'added') result.imagesAdded++;
      else if (outcome.image === 'replaced') result.imagesReplaced++;
      else if (outcome.image === 'preserved') result.imagesPreserved++;
      if (outcome.imageError) result.errors.push({ id: outcome.id, error: outcome.imageError });
    }
    for (const id of stale) recordStale(result, id);
    failures.forEach(recordFailure);
  } catch (error) {
    for (const { entry } of prepared) recordFailure({ id: entry.id, error: errorMessage(error) });
  }
}

finishImport(result, backup);
