import { createHash } from 'crypto';
import { isUsageAudit, shouldArchiveUsage } from './usage-audit.js';

export type CorpusItemType = 'vocab' | 'phrase' | 'sentence';

export interface CorpusExportRecord {
  id: string;
  type: CorpusItemType;
  sourceHash: string;
  wasArchived: boolean;
  data: Record<string, unknown>;
}

export interface CorpusAuditEntry {
  id: string;
  type: CorpusItemType;
  sourceHash: string;
  data: Record<string, unknown>;
  archiveForUsage: boolean;
}

export interface CorpusAuditBundle {
  version: 1;
  generatedAt: number;
  model: string;
  entries: CorpusAuditEntry[];
}

const ITEM_TYPES = new Set<CorpusItemType>(['vocab', 'phrase', 'sentence']);
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withoutImageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImageFields(child)]));
}

export function corpusSourceHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(withoutImageFields(data))).digest('hex');
}

function hasCompleteAudit(type: CorpusItemType, data: Record<string, any>): boolean {
  if (!isUsageAudit(data.usageAudit)) return false;
  if (type !== 'phrase') return true;
  return Array.isArray(data.vocabs) && data.vocabs.every((vocab: unknown) =>
    isRecord(vocab) && isUsageAudit(vocab.usageAudit));
}

export function validateCorpusAuditBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  if (value.version !== 1) return 'unsupported bundle version';
  if (typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt) || value.generatedAt <= 0) {
    return 'bundle generatedAt is invalid';
  }
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 200) {
    return 'bundle model is invalid';
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 20_000) {
    return 'bundle entries must contain 1 to 20000 records';
  }
  const ids = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) {
      return `entry ${index} id is invalid`;
    }
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (typeof entry.type !== 'string' || !ITEM_TYPES.has(entry.type as CorpusItemType)) {
      return `entry ${index} type is invalid`;
    }
    if (typeof entry.sourceHash !== 'string' || !SHA256.test(entry.sourceHash)) {
      return `entry ${index} sourceHash is invalid`;
    }
    if (!isRecord(entry.data) || entry.data.id !== entry.id) return `entry ${index} data identity is invalid`;
    if (!hasCompleteAudit(entry.type as CorpusItemType, entry.data)) {
      return `entry ${index} does not contain a complete usage audit`;
    }
    if (typeof entry.archiveForUsage !== 'boolean') return `entry ${index} archiveForUsage is invalid`;
    const expectedArchive = shouldArchiveUsage(entry.data.usageAudit.status, entry.data.usageAudit.confidence);
    if (entry.archiveForUsage !== expectedArchive) return `entry ${index} archiveForUsage disagrees with usage audit`;
  }
  return null;
}
