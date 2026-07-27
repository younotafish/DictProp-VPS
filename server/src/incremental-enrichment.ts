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

export function collectIncrementalEnrichmentItems(
  items: any[],
  installedAt: number,
  limit: number,
): any[] {
  return items
    .filter(item => Number(item?.savedAt) >= installedAt && itemNeedsIncrementalEnrichment(item))
    .sort((a, b) => (a.savedAt - b.savedAt) || String(a.data.id).localeCompare(String(b.data.id)))
    .slice(0, Math.max(0, limit));
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
