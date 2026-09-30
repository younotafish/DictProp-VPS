import { readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { corpusSourceHash } from '../corpus-audit.js';
import { db, getItemById, listAllUsers, upsertItemImageBinary } from '../db.js';
import { env } from '../env.js';
import { detectImageMimeType } from '../image-format.js';
import { backupBeforeWrite, checkpointAfterWrite, recordStale, StaleEntryError, writeOverLiveItem } from '../import-support.js';
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
const backup = await backupBeforeWrite('offline-images');
const result = {
  total: bundle.entries.length,
  replaced: 0,
  stale: 0,
  staleIds: [] as string[],
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};

type Entry = OfflineImageBundle['entries'][number];
type PreparedEntry = { entry: Entry; image: Buffer; mimeType: string };
type Failure = { id: string; error: unknown };

const readImage = (entry: Entry): PreparedEntry => {
  const imagePath = resolve(bundleRoot, entry.imageFile);
  if (!imagePath.startsWith(`${bundleRoot}${sep}`)) throw new Error('image path escapes bundle root');
  const image = readFileSync(imagePath);
  if (image.length === 0 || image.length > 10 * 1024 * 1024) throw new Error('image size is invalid');
  const mimeType = detectImageMimeType(image);
  if (!mimeType) throw new Error('image format is invalid');
  return { entry, image, mimeType };
};

const withImageMarkers = (data: any, entries: PreparedEntry[]) => {
  const markers = new Map<string, object>();
  for (const { entry } of entries) {
    if (!entry.promptHash) continue;
    markers.set(entry.imageId, {
      version: 1,
      provider: 'local-ernie',
      model: bundle.model,
      generatedAt: bundle.generatedAt,
      promptHash: entry.promptHash,
    });
  }
  let next = markers.has(data.id) ? { ...data, localImageEnrichment: markers.get(data.id) } : data;
  if (Array.isArray(next.vocabs)) {
    next = {
      ...next,
      vocabs: next.vocabs.map((vocab: any) =>
        markers.has(vocab?.id) ? { ...vocab, localImageEnrichment: markers.get(vocab.id) } : vocab),
    };
  }
  return next;
};

// A savepoint per parent: its images are stored only together with the parent write that publishes
// them. Image bytes live outside the item JSON, so that write also bumps the parent's revision once
// and revision-delta clients receive the new content-hash marker and drop an older cached image.
const publishImages = db.transaction((live: any, entries: PreparedEntry[]) => {
  writeOverLiveItem(live, owner.id, withImageMarkers(live.data, entries));
  for (const { entry, image, mimeType } of entries) {
    if (!upsertItemImageBinary(entry.imageId, image, mimeType, owner.id)) {
      throw new Error(`image ${entry.imageId} could not be stored`);
    }
  }
});

// Parents are checked against their live rows inside the chunk's write transaction, so nothing a
// client committed after the bundle was generated can be overwritten or published over. Entries for a
// parent that changed or went away since are stale.
const applyChunk = db.transaction((parents: Array<[string, PreparedEntry[]]>) => {
  const stored: string[] = [];
  const stale: string[] = [];
  const failures: Failure[] = [];
  for (const [parentId, entries] of parents) {
    const live = getItemById(parentId, owner.id, false) as any;
    if (!live || live.isDeleted) {
      stale.push(...entries.map(({ entry }) => entry.imageId));
      continue;
    }
    // Every entry is checked before any marker is applied: the markers change this hash.
    const liveHash = corpusSourceHash(live.data);
    const imageIds = new Set([
      live.data.id,
      ...(Array.isArray(live.data.vocabs) ? live.data.vocabs.map((vocab: any) => vocab?.id) : []),
    ]);
    const ready = entries.filter(({ entry }) => {
      if (entry.parentHash !== liveHash) stale.push(entry.imageId);
      else if (!imageIds.has(entry.imageId)) failures.push({ id: entry.imageId, error: 'image id does not belong to parent item' });
      else return true;
      return false;
    });
    if (ready.length === 0) continue;
    try {
      publishImages(live, ready);
      stored.push(...ready.map(({ entry }) => entry.imageId));
    } catch (error) {
      for (const { entry } of ready) {
        if (error instanceof StaleEntryError) stale.push(entry.imageId);
        else failures.push({ id: entry.imageId, error });
      }
    }
  }
  return { stored, stale, failures };
});

const recordFailure = ({ id, error }: Failure) => {
  result.skipped++;
  result.errors.push({ id, error: error instanceof Error ? error.message : String(error) });
};

// A parent's entries stay in one chunk: the first marker written changes the hash the rest are checked by.
const groups = new Map<string, Entry[]>();
for (const entry of bundle.entries) {
  const group = groups.get(entry.parentId);
  if (group) group.push(entry);
  else groups.set(entry.parentId, [entry]);
}
const chunks: Array<Array<[string, Entry[]]>> = [];
let chunkEntries = Infinity;
for (const group of groups) {
  if (chunkEntries >= 100) {
    chunks.push([]);
    chunkEntries = 0;
  }
  chunks[chunks.length - 1].push(group);
  chunkEntries += group[1].length;
}

// Each chunk reads only its own files and commits on its own: memory stays bounded and the write lock
// is released often enough for the live app to keep saving while the import runs.
for (const chunk of chunks) {
  const parents: Array<[string, PreparedEntry[]]> = [];
  for (const [parentId, entries] of chunk) {
    const readable: PreparedEntry[] = [];
    for (const entry of entries) {
      try {
        readable.push(readImage(entry));
      } catch (error) {
        recordFailure({ id: entry.imageId, error });
      }
    }
    if (readable.length > 0) parents.push([parentId, readable]);
  }
  if (parents.length === 0) continue;
  try {
    const { stored, stale, failures } = applyChunk.immediate(parents);
    result.replaced += stored.length;
    for (const id of stale) recordStale(result, id);
    failures.forEach(recordFailure);
  } catch (error) {
    for (const [, entries] of parents) for (const { entry } of entries) recordFailure({ id: entry.imageId, error });
  }
}

checkpointAfterWrite();
process.stdout.write(`${JSON.stringify({ ...result, backup })}\n`);
if (result.errors.length > 0) process.exitCode = 1;
