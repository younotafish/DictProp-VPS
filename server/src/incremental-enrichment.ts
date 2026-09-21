import { createHash } from 'node:crypto';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { hasCompleteGeneratedVocabMetadata, isValidGeneratedExampleSet } from './ai-response.js';

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function advancedVocabContentHash(data: any): string {
  if (!data || typeof data !== 'object') return '';
  const content = Object.fromEntries(Object.entries(data)
    .filter(([key]) => key !== 'imageUrl' && key !== 'advancedEnrichment' && key !== 'localImageEnrichment'));
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

export function hasCurrentLocalAdvancedEnrichment(data: any): boolean {
  const marker = data?.advancedEnrichment;
  return marker?.version === 1 && marker?.provider === 'local-mlx' &&
    typeof marker.model === 'string' && marker.model.length > 0 &&
    Number.isFinite(marker.generatedAt) && marker.generatedAt > 0 &&
    typeof marker.contentHash === 'string' && marker.contentHash === advancedVocabContentHash(data);
}

export function imagePromptHash(prompt: unknown): string {
  return createHash('sha256').update(String(prompt || '').trim()).digest('hex');
}

export function hasCurrentLocalImageEnrichment(data: any): boolean {
  const marker = data?.localImageEnrichment;
  return marker?.version === 1 && marker?.provider === 'local-ernie' &&
    typeof marker.model === 'string' && marker.model.length > 0 &&
    Number.isFinite(marker.generatedAt) && marker.generatedAt > 0 &&
    marker.promptHash === imagePromptHash(data?.imagePrompt);
}

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
    return !hasCompleteVocabContent(item.data) || !hasCurrentLocalAdvancedEnrichment(item.data) ||
      (!!item.data.imagePrompt?.trim() && hasCurrentLocalAdvancedEnrichment(item.data) &&
        !hasCurrentLocalImageEnrichment(item.data)) ||
      (!!item.data.imagePrompt?.trim() && !hasStoredImage(item.data));
  }
  if (item.type === 'phrase') {
    const phraseNeedsImage = !!item.data.imagePrompt?.trim() && !hasStoredImage(item.data);
    const hasAdvancedCard = Array.isArray(item.data.vocabs) &&
      item.data.vocabs.some(hasCurrentLocalAdvancedEnrichment);
    const phraseNeedsLocalImage = !!item.data.imagePrompt?.trim() && hasAdvancedCard &&
      !hasCurrentLocalImageEnrichment(item.data);
    const vocabNeedsWork = Array.isArray(item.data.vocabs) && item.data.vocabs.some((vocab: any) =>
      !hasCompleteVocabContent(vocab) || !hasCurrentLocalAdvancedEnrichment(vocab) ||
      (!!vocab?.imagePrompt?.trim() && hasCurrentLocalAdvancedEnrichment(vocab) &&
        !hasCurrentLocalImageEnrichment(vocab)) ||
      (!!vocab?.imagePrompt?.trim() && !hasStoredImage(vocab)));
    return phraseNeedsImage || phraseNeedsLocalImage || vocabNeedsWork;
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
      recentVocabAdvanced: 0,
      recentNestedVocabAdvanced: 0,
      recentVocabLocalImage: 0,
      recentPhraseLocalImage: 0,
      recentNestedVocabLocalImage: 0,
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
      if (recent && !hasCurrentLocalAdvancedEnrichment(item.data)) summary.gaps.recentVocabAdvanced++;
      if (recent && item.data.imagePrompt?.trim() && hasCurrentLocalAdvancedEnrichment(item.data) &&
          !hasCurrentLocalImageEnrichment(item.data)) summary.gaps.recentVocabLocalImage++;
      if (item.data.imagePrompt?.trim() && !hasStoredImage(item.data)) summary.gaps.vocabImage++;
      continue;
    }
    if (item.type === 'phrase') {
      summary.byType.phrase++;
      if (item.data.imagePrompt?.trim() && !hasStoredImage(item.data)) summary.gaps.phraseImage++;
      if (Array.isArray(item.data.vocabs)) {
        const hasAdvancedCard = item.data.vocabs.some(hasCurrentLocalAdvancedEnrichment);
        if (recent && item.data.imagePrompt?.trim() && hasAdvancedCard &&
            !hasCurrentLocalImageEnrichment(item.data)) summary.gaps.recentPhraseLocalImage++;
        if (recent) {
          summary.gaps.recentNestedVocabAdvanced += item.data.vocabs.filter((vocab: any) =>
            !hasCurrentLocalAdvancedEnrichment(vocab)).length;
          summary.gaps.recentNestedVocabLocalImage += item.data.vocabs.filter((vocab: any) =>
            vocab?.imagePrompt?.trim() && hasCurrentLocalAdvancedEnrichment(vocab) &&
            !hasCurrentLocalImageEnrichment(vocab)).length;
        }
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
