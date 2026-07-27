import { createHash } from 'node:crypto';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';

export interface IncrementalSavedSentenceSource {
  version: 1;
  exportedAt: number;
  sourceGeneratedAt: number;
  sentences: Array<{
    id: string;
    text: string;
    sourceWord: string;
    sourceSense?: string;
    textHash: string;
  }>;
  stats: {
    corpusRecords: number;
    savedSentences: number;
    incompleteSentences: number;
    newlyDiscovered: number;
    changedSentences: number;
  };
}

export function collectIncompleteSavedSentences(
  corpus: any,
  previousSource?: any,
  generatedAt = Date.now(),
): IncrementalSavedSentenceSource {
  if (corpus?.version !== 1 || !Array.isArray(corpus.items)) {
    throw new Error('Corpus export is invalid');
  }
  if (previousSource !== undefined &&
      (previousSource?.version !== 1 || !Array.isArray(previousSource.sentences))) {
    throw new Error('Previous saved-sentence source is invalid');
  }

  const previousById = new Map<string, any>();
  for (const sentence of previousSource?.sentences ?? []) {
    if (typeof sentence?.id !== 'string' || !sentence.id ||
        typeof sentence.textHash !== 'string' || previousById.has(sentence.id)) {
      throw new Error('Previous saved-sentence source contains an invalid or duplicate id');
    }
    previousById.set(sentence.id, sentence);
  }

  const sentences: IncrementalSavedSentenceSource['sentences'] = [];
  const seenIds = new Set<string>();
  let savedSentences = 0;
  let newlyDiscovered = 0;
  let changedSentences = 0;

  for (const item of corpus.items) {
    if (item?.type !== 'sentence' || item.wasArchived === true) continue;
    savedSentences++;
    const data = item.data;
    if (!data || typeof data.id !== 'string' || !data.id ||
        typeof data.text !== 'string' || !data.text.trim() || seenIds.has(data.id)) {
      throw new Error('Corpus export contains an invalid or duplicate saved sentence');
    }
    seenIds.add(data.id);
    if (hasCompleteSentenceAnalysis(data.analysis)) continue;

    const textHash = createHash('sha256').update(data.text).digest('hex');
    const previous = previousById.get(data.id);
    if (!previous) newlyDiscovered++;
    else if (previous.textHash !== textHash) changedSentences++;
    sentences.push({
      id: data.id,
      text: data.text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash,
    });
  }

  sentences.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: 1,
    exportedAt: generatedAt,
    sourceGeneratedAt: Number(corpus.exportedAt || 0),
    sentences,
    stats: {
      corpusRecords: corpus.items.length,
      savedSentences,
      incompleteSentences: sentences.length,
      newlyDiscovered,
      changedSentences,
    },
  };
}
