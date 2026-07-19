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

export const sortVocabCardsByUsage = (vocabs: VocabCard[]): VocabCard[] =>
  vocabs
    .map((vocab, index) => ({ vocab, index }))
    .sort((a, b) =>
      getUsagePriority(a.vocab.usageAudit?.status) - getUsagePriority(b.vocab.usageAudit?.status) ||
      a.index - b.index,
    )
    .map(entry => entry.vocab);

export const sortStoredSensesByUsage = (items: StoredItem[]): StoredItem[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aStatus = a.item.type === 'vocab' ? (a.item.data as VocabCard).usageAudit?.status : undefined;
      const bStatus = b.item.type === 'vocab' ? (b.item.data as VocabCard).usageAudit?.status : undefined;
      return getUsagePriority(aStatus) - getUsagePriority(bStatus) || a.index - b.index;
    })
    .map(entry => entry.item);
