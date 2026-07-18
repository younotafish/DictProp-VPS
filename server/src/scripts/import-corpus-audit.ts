import { readFileSync } from 'fs';
import { resolve } from 'path';
import { corpusSourceHash, validateCorpusAuditBundle, type CorpusAuditBundle } from '../corpus-audit.js';
import { getItemById, listAllUsers, upsertItem } from '../db.js';
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

const result = { total: bundle.entries.length, updated: 0, archivedForUsage: 0, skipped: 0, errors: [] as Array<{ id: string; error: string }> };

for (const entry of bundle.entries) {
  try {
    const current = getItemById(entry.id, owner.id, false) as any;
    if (!current || current.isDeleted) throw new Error('item is missing or deleted');
    if (current.type !== entry.type) throw new Error('item type changed after export');
    if (corpusSourceHash(current.data) !== entry.sourceHash) throw new Error('item content changed after export');

    const candidate = {
      ...current,
      data: entry.data,
      isArchived: current.isArchived === true || entry.archiveForUsage,
      updatedAt: Math.max(Date.now(), Number(current.updatedAt || 0) + 1),
    };
    const itemError = validateStoredItem(candidate);
    if (itemError) throw new Error(itemError);
    const write = upsertItem(candidate, owner.id);
    if (write.conflicted) throw new Error('item changed while the audit was being imported');
    result.updated++;
    if (!current.isArchived && entry.archiveForUsage) result.archivedForUsage++;
  } catch (error) {
    result.skipped++;
    result.errors.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
