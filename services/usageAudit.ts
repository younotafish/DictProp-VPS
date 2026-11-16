import { USAGE_PRIORITY } from '../server/src/shared/usage-audit';
import type { StoredItem, UsageStatus, VocabCard } from '../types';

// A sense the audit hasn't reached yet ranks as current general usage.
export const getUsagePriority = (status?: UsageStatus): number =>
  status ? USAGE_PRIORITY[status] : 1;

const senseUsagePriority = (item: StoredItem): number =>
  getUsagePriority(item.type === 'vocab' ? (item.data as VocabCard).usageAudit?.status : undefined);

// Both sorts are stable, so senses of equal priority keep their order. A single sense returns as is.
export const sortVocabCardsByUsage = (vocabs: VocabCard[]): VocabCard[] =>
  vocabs.length < 2
    ? vocabs
    : [...vocabs].sort((a, b) => getUsagePriority(a.usageAudit?.status) - getUsagePriority(b.usageAudit?.status));

export const sortStoredSensesByUsage = (items: StoredItem[]): StoredItem[] =>
  items.length < 2 ? items : [...items].sort((a, b) => senseUsagePriority(a) - senseUsagePriority(b));
