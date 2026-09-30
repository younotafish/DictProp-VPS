import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import {
  db,
  getItemById,
  hasItemImage,
  listAllUsers,
  upsertItemImageBinary,
} from '../db.js';
import { env } from '../env.js';
import { detectImageMimeType } from '../image-format.js';
import { backupBeforeWrite, checkpointAfterWrite, recordStale, StaleEntryError, writeOverLiveItem } from '../import-support.js';
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
type PreparedEntry = { entry: Entry; image: Buffer | null; mimeType: string | null };
type Outcome = { id: string; image: 'added' | 'replaced' | 'preserved' | null; imageError?: string };

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

// Only images that will be written are read, and only for the current chunk.
const prepare = (entry: Entry): PreparedEntry => {
  if (!entry.imageFile || (entry.replaceImage !== true && hasItemImage(entry.id, owner.id))) {
    return { entry, image: null, mimeType: null };
  }
  const imagePath = resolve(bundleRoot, entry.imageFile);
  if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error('image path escapes bundle root');
  const image = readFileSync(imagePath);
  if (image.length === 0 || image.length > 10 * 1024 * 1024) throw new Error('image size is invalid');
  const mimeType = detectImageMimeType(image);
  if (!mimeType) throw new Error('image format is invalid');
  return { entry, image, mimeType };
};

// A savepoint per sentence, checked against its live row: the analysis is written over what is stored
// now with the stored revision, and the image is stored only after that write went through cleanly.
const importSentence = db.transaction(({ entry, image, mimeType }: PreparedEntry): Outcome => {
  const live = getItemById(entry.id, owner.id, false) as any;
  if (!live || live.isDeleted) throw new StaleEntryError('sentence is missing or deleted');
  if (live.type !== 'sentence') throw new Error('item is no longer a sentence');
  const liveText = typeof live.data?.text === 'string' ? live.data.text : '';
  if (createHash('sha256').update(liveText).digest('hex') !== entry.textHash) {
    throw new StaleEntryError('sentence text changed after export');
  }
  const imageExists = hasItemImage(entry.id, owner.id);
  if (entry.imageFile && !image && !imageExists) {
    throw new StaleEntryError('image was removed while the backfill was imported');
  }
  writeOverLiveItem(live, owner.id, {
    ...live.data,
    analysis: entry.analysis,
    analysisGeneratedAt: entry.generatedAt,
  });

  if (!entry.imageFile) return { id: entry.id, image: null };
  if (imageExists && entry.replaceImage !== true) return { id: entry.id, image: 'preserved' };
  // A refused image leaves the new analysis in place and is reported on its own.
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

checkpointAfterWrite();
process.stdout.write(`${JSON.stringify({ ...result, backup })}\n`);
if (result.errors.length > 0) process.exitCode = 1;
