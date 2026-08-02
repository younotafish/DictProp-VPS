import type { SentenceAnalysis } from '../types';
import { jsonRequest, requestJson } from './http';

export interface PreparedSentenceEnrichment {
  analysis: SentenceAnalysis;
  analysisGeneratedAt: number;
  imageUrl?: string;
}

export default async function loadPreparedSentenceEnrichment(
  text: string,
): Promise<PreparedSentenceEnrichment | null> {
  const result = await requestJson<
    | ({ found: true } & PreparedSentenceEnrichment)
    | { found: false }
  >(
    '/api/sentence-enrichments/lookup',
    jsonRequest('POST', { text }),
    'Load prepared sentence analysis',
  );
  if (!result.found) return null;
  const { found: _found, ...enrichment } = result;
  return enrichment;
}
