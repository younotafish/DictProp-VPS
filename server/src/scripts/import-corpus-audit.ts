import { readFileSync } from 'fs';
import { resolve } from 'path';
import { corpusAuditDataState, validateCorpusAuditBundle, type CorpusAuditBundle } from '../corpus-audit.js';
import { getAllItems, listAllUsers, upsertMany } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { isSentenceAnalysis } from '../sentence-analysis.js';
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
  missingOrDeleted: 0,
  archivedForUsage: 0,
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};
const pending: any[] = [];
const archivedById = new Set<string>();
const currentById = new Map(getAllItems(true, owner.id).map(item => [item.data.id, item]));
const finiteNonNegative = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const withoutLaterSentenceEnrichment = (data: any, type: string) => {
  if (type !== 'sentence' || !data || typeof data !== 'object') return data;
  const { analysis: _analysis, analysisGeneratedAt: _generatedAt, ...auditedData } = data;
  return auditedData;
};

for (const entry of bundle.entries) {
  try {
    const current = currentById.get(entry.id) as any;
    if (!current || current.isDeleted) {
      result.missingOrDeleted++;
      continue;
    }
    if (current.type !== entry.type) throw new Error('item type changed after export');
    const dataState = corpusAuditDataState(withoutLaterSentenceEnrichment(current.data, entry.type), entry);
    if (dataState === 'target') {
      result.alreadyApplied++;
      continue;
    }
    if (dataState === 'changed') throw new Error('item content changed after export');

    const { project: _legacyProject, ...currentWithoutProject } = current;
    const currentSrs = current.srs && typeof current.srs === 'object' ? current.srs : {};
    const preservedSentenceAnalysis = entry.type === 'sentence' && isSentenceAnalysis(current.data.analysis)
      ? {
          analysis: current.data.analysis,
          ...(finiteNonNegative(current.data.analysisGeneratedAt, 0) > 0
            ? { analysisGeneratedAt: current.data.analysisGeneratedAt }
            : {}),
        }
      : {};
    const candidate = {
      ...currentWithoutProject,
      data: { ...entry.data, ...preservedSentenceAnalysis },
      srs: {
        ...currentSrs,
        id: entry.id,
        type: entry.type,
        nextReview: finiteNonNegative(currentSrs.nextReview, 0),
        interval: finiteNonNegative(currentSrs.interval, 0),
        memoryStrength: finiteNonNegative(currentSrs.memoryStrength, 0),
        lastReviewDate: finiteNonNegative(currentSrs.lastReviewDate, 0),
        totalReviews: finiteNonNegative(currentSrs.totalReviews, 0),
        correctStreak: finiteNonNegative(currentSrs.correctStreak, 0),
        stability: finiteNonNegative(currentSrs.stability, 0),
      },
      savedAt: finiteNonNegative(current.savedAt, Date.now()),
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

const recordWrite = (candidate: any, conflicts: Set<string>) => {
  const id = candidate.data.id;
  if (conflicts.has(id)) {
    result.skipped++;
    result.errors.push({ id, error: 'item changed while the audit was being imported' });
    return;
  }
  result.updated++;
  if (archivedById.has(id)) result.archivedForUsage++;
};

for (let index = 0; index < pending.length; index += 500) {
  const batch = pending.slice(index, index + 500);
  try {
    const write = upsertMany(batch, owner.id);
    const conflicts = new Set(write.conflicts);
    for (const candidate of batch) recordWrite(candidate, conflicts);
  } catch (batchError) {
    // Isolate a bad legacy record instead of losing every valid item in its transaction batch.
    for (const candidate of batch) {
      try {
        const write = upsertMany([candidate], owner.id);
        recordWrite(candidate, new Set(write.conflicts));
      } catch (error) {
        result.skipped++;
        result.errors.push({
          id: candidate.data.id,
          error: error instanceof Error ? error.message : String(error || batchError),
        });
      }
    }
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
