import type { StoredItem, UsageStatus, VocabCard } from '../types';

const USAGE_PRIORITY: Record<UsageStatus, number> = {
  modern_american: 0,
  current_general: 1,
  narrow_specialized: 2,
  british_only: 3,
  rare_or_dated: 4,
};

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
