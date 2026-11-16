// The Mac's enrichment cycle runs this, through prepare-incremental-saved-sentence-source.ts under tsx; it ships with
// the server only because it shares the server's sentence contracts.
import { fieldsOf } from './local-enrichment-markers.js';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';
import { sentenceTextHash } from './sentence-lookup.js';

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

/** The text hashes a previous source recorded, by sentence id; none without a previous source. */
function previousTextHashes(previousSource: unknown): Map<string, string> {
  const textHashes = new Map<string, string>();
  if (previousSource === undefined) return textHashes;
  const { version, sentences } = fieldsOf(previousSource);
  if (version !== 1 || !Array.isArray(sentences)) {
    throw new Error('Previous saved-sentence source is invalid');
  }
  for (const sentence of sentences) {
    const { id, textHash } = fieldsOf(sentence);
    if (typeof id !== 'string' || !id || typeof textHash !== 'string' || textHashes.has(id)) {
      throw new Error('Previous saved-sentence source contains an invalid or duplicate id');
    }
    textHashes.set(id, textHash);
  }
  return textHashes;
}

/** A corpus export, and the source this returned last time when there is one, both as JSON read from disk. */
export function collectIncompleteSavedSentences(
  corpus: unknown,
  previousSource?: unknown,
  generatedAt = Date.now(),
): IncrementalSavedSentenceSource {
  const { version, items, exportedAt } = fieldsOf(corpus);
  if (version !== 1 || !Array.isArray(items)) {
    throw new Error('Corpus export is invalid');
  }
  const previousHashes = previousTextHashes(previousSource);

  const sentences: IncrementalSavedSentenceSource['sentences'] = [];
  const seenIds = new Set<string>();
  let savedSentences = 0;
  let newlyDiscovered = 0;
  let changedSentences = 0;

  for (const item of items) {
    const record = fieldsOf(item);
    if (record.type !== 'sentence' || record.wasArchived === true) continue;
    savedSentences++;
    const { id, text, sourceWord, sourceSense, analysis } = fieldsOf(record.data);
    if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim() || seenIds.has(id)) {
      throw new Error('Corpus export contains an invalid or duplicate saved sentence');
    }
    seenIds.add(id);
    if (hasCompleteSentenceAnalysis(analysis)) continue;

    const textHash = sentenceTextHash(text);
    const previousHash = previousHashes.get(id);
    if (previousHash === undefined) newlyDiscovered++;
    else if (previousHash !== textHash) changedSentences++;
    sentences.push({
      id,
      text,
      sourceWord: typeof sourceWord === 'string' ? sourceWord : '',
      ...(typeof sourceSense === 'string' ? { sourceSense } : {}),
      textHash,
    });
  }

  sentences.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: 1,
    exportedAt: generatedAt,
    sourceGeneratedAt: Number(exportedAt || 0),
    sentences,
    stats: {
      corpusRecords: items.length,
      savedSentences,
      incompleteSentences: sentences.length,
      newlyDiscovered,
      changedSentences,
    },
  };
}
