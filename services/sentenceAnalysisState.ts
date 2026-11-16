/** What a sentence's analysis page shows: the analysis, or why there's none on screen yet. */
export type AnalysisPlaceholderState = 'ready' | 'loading' | 'failed' | 'missing';

/**
 * 'ready' when the sentence has an analysis to show, even while a fetch upgrades it; otherwise 'loading' while a fetch
 * for it runs, 'failed' when the last fetch threw (a network or server error, which the view tries again), and
 * 'missing' when the shared pool has no analysis for it (a reply that found none is not a failure).
 */
export function analysisPlaceholderState({ hasAnalysis, loading, failed }: {
  hasAnalysis: boolean;
  loading: boolean;
  failed: boolean;
}): AnalysisPlaceholderState {
  if (hasAnalysis) return 'ready';
  if (loading) return 'loading';
  if (failed) return 'failed';
  return 'missing';
}
