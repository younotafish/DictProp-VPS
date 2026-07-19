import { readFileSync } from 'fs';
import { resolve } from 'path';
import { corpusAuditDataState, validateCorpusAuditBundle, type CorpusAuditBundle } from '../corpus-audit.js';
import { getAllItems, listAllUsers, upsertMany } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { validateStoredItem } from '../validation.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-corpus-audit <manifest.json>');

const bundle = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as CorpusAuditBundle;
const validationError = validateCorpusAuditBundle(bundle);
if (validationError) throw new Error(validationError);

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const result = {
  total: bundle.entries.length,
  updated: 0,
  alreadyApplied: 0,
  archivedForUsage: 0,
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};
const pending: any[] = [];
const archivedById = new Set<string>();
const currentById = new Map(getAllItems(true, owner.id).map(item => [item.data.id, item]));

for (const entry of bundle.entries) {
  try {
    const current = currentById.get(entry.id) as any;
    if (!current || current.isDeleted) throw new Error('item is missing or deleted');
    if (current.type !== entry.type) throw new Error('item type changed after export');
    const dataState = corpusAuditDataState(current.data, entry);
    if (dataState === 'target') {
      result.alreadyApplied++;
      continue;
    }
    if (dataState === 'changed') throw new Error('item content changed after export');

    const candidate = {
      ...current,
      data: entry.data,
      isArchived: current.isArchived === true || entry.archiveForUsage,
      updatedAt: Math.max(Date.now(), Number(current.updatedAt || 0) + 1),
    };
    const itemError = validateStoredItem(candidate);
    if (itemError) throw new Error(itemError);
    pending.push(candidate);
    if (!current.isArchived && entry.archiveForUsage) archivedById.add(entry.id);
  } catch (error) {
    result.skipped++;
    result.errors.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
  }
}

for (let index = 0; index < pending.length; index += 500) {
  const batch = pending.slice(index, index + 500);
  try {
    const write = upsertMany(batch, owner.id);
    const conflicts = new Set(write.conflicts);
    for (const candidate of batch) {
      const id = candidate.data.id;
      if (conflicts.has(id)) {
        result.skipped++;
        result.errors.push({ id, error: 'item changed while the audit was being imported' });
        continue;
      }
      result.updated++;
      if (archivedById.has(id)) result.archivedForUsage++;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const candidate of batch) {
      result.skipped++;
      result.errors.push({ id: candidate.data.id, error: message });
    }
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
