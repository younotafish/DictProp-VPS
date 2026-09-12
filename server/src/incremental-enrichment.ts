import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { hasCompleteGeneratedVocabMetadata, isValidGeneratedExampleSet } from './ai-response.js';

export function hasStoredImage(data: any): boolean {
  return typeof data?.imageUrl === 'string' && data.imageUrl.length > 0;
}

export function hasCompleteVocabContent(data: any): boolean {
  return hasCompleteGeneratedVocabMetadata(data) && isValidGeneratedExampleSet(data?.examples);
}

export function itemNeedsIncrementalEnrichment(item: any): boolean {
  if (!item?.data || item.isDeleted || item.isArchived) return false;
  if (item.type === 'sentence') {
    return !hasCompleteSentenceAnalysis(item.data.analysis) || !hasStoredImage(item.data);
  }
  if (item.type === 'vocab') {
    return !hasCompleteVocabContent(item.data) ||
      (!!item.data.imagePrompt?.trim() && !hasStoredImage(item.data));
  }
  if (item.type === 'phrase') {
    const phraseNeedsImage = !!item.data.imagePrompt?.trim() && !hasStoredImage(item.data);
    const vocabNeedsImage = Array.isArray(item.data.vocabs) && item.data.vocabs.some((vocab: any) =>
      !!vocab?.imagePrompt?.trim() && !hasStoredImage(vocab));
    return phraseNeedsImage || vocabNeedsImage;
  }
  return false;
}

export function itemNeedsHistoricalEnrichment(item: any): boolean {
  if (!item?.data || item.isDeleted || item.isArchived) return false;
  if (item.type === 'sentence') return itemNeedsIncrementalEnrichment(item);
  if (item.type === 'vocab') {
    return !!item.data.imagePrompt?.trim() && !hasStoredImage(item.data);
  }
  if (item.type === 'phrase') {
    const phraseNeedsImage = !!item.data.imagePrompt?.trim() && !hasStoredImage(item.data);
    const vocabNeedsImage = Array.isArray(item.data.vocabs) && item.data.vocabs.some((vocab: any) =>
      !!vocab?.imagePrompt?.trim() && !hasStoredImage(vocab));
    return phraseNeedsImage || vocabNeedsImage;
  }
  return false;
}

export function collectIncrementalEnrichmentItems(
  items: any[],
  prioritySince: number,
  limit: number,
): any[] {
  return items
    .filter(item => Number(item?.savedAt) >= prioritySince
      ? itemNeedsIncrementalEnrichment(item)
      : itemNeedsHistoricalEnrichment(item))
    .sort((a, b) => {
      // Keep newly saved material responsive without permanently excluding the historical backlog.
      const aPriority = Number(a?.savedAt) >= prioritySince ? 0 : 1;
      const bPriority = Number(b?.savedAt) >= prioritySince ? 0 : 1;
      return (aPriority - bPriority) ||
        (Number(a?.savedAt || 0) - Number(b?.savedAt || 0)) ||
        String(a.data.id).localeCompare(String(b.data.id));
    })
    .slice(0, Math.max(0, limit));
}

export function summarizeIncrementalEnrichmentBacklog(items: any[], prioritySince: number) {
  const pending = collectIncrementalEnrichmentItems(items, prioritySince, Number.MAX_SAFE_INTEGER);
  const summary = {
    items: pending.length,
    recentItems: 0,
    historicalItems: 0,
    byType: { sentence: 0, vocab: 0, phrase: 0 },
    gaps: {
      sentenceDetailedAnalysis: 0,
      sentenceImage: 0,
      recentVocabContent: 0,
      vocabImage: 0,
      phraseImage: 0,
      nestedVocabImage: 0,
    },
  };

  for (const item of pending) {
    const recent = Number(item?.savedAt) >= prioritySince;
    if (recent) summary.recentItems++;
    else summary.historicalItems++;

    if (item.type === 'sentence') {
      summary.byType.sentence++;
      if (!hasCompleteSentenceAnalysis(item.data.analysis)) summary.gaps.sentenceDetailedAnalysis++;
      if (!hasStoredImage(item.data)) summary.gaps.sentenceImage++;
      continue;
    }
    if (item.type === 'vocab') {
      summary.byType.vocab++;
      if (recent && !hasCompleteVocabContent(item.data)) summary.gaps.recentVocabContent++;
      if (item.data.imagePrompt?.trim() && !hasStoredImage(item.data)) summary.gaps.vocabImage++;
      continue;
    }
    if (item.type === 'phrase') {
      summary.byType.phrase++;
      if (item.data.imagePrompt?.trim() && !hasStoredImage(item.data)) summary.gaps.phraseImage++;
      if (Array.isArray(item.data.vocabs)) {
        summary.gaps.nestedVocabImage += item.data.vocabs.filter((vocab: any) =>
          !!vocab?.imagePrompt?.trim() && !hasStoredImage(vocab)).length;
      }
    }
  }
  return summary;
}

export function incrementalEnrichmentItemKey(item: any): string {
  return `${String(item?.type || '')}:${String(item?.data?.id || '')}`;
}

export function selectUnattemptedIncrementalItems(
  pending: any[],
  attempted: ReadonlySet<string>,
  limit: number,
): any[] {
  return pending
    .filter(item => !attempted.has(incrementalEnrichmentItemKey(item)))
    .slice(0, Math.max(0, limit));
}

export function selectReplacementVocab(existing: any, generated: any[]): any | null {
  if (!Array.isArray(generated) || generated.length === 0) return null;
  const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
  const word = normalize(existing?.word);
  const sense = normalize(existing?.sense);
  return generated.find(card => normalize(card?.word) === word && normalize(card?.sense) === sense) ??
    generated.find(card => normalize(card?.word) === word) ??
    generated[0] ?? null;
}
