import { isVocabItem, savedVocabKey, type StoredItem, type VocabCard } from '../types';
import { makeVocabStoredItem } from './items';
import { log, warn } from './logger';

/** How far a batch import has got. */
export interface BatchImportProgress { current: number; total: number; skipped: number; failed: number; saved: number; isRunning: boolean }

/** How a batch import ended: with every listed word already saved, or with what it saved and what failed. */
export type BatchImportOutcome =
  | { kind: 'all-saved'; listed: number }
  | { kind: 'done'; saved: number; skipped: number; failed: number; failedWords: string[]; importedIds: string[] };

export interface BatchImportJob {
  /** The library as it stands. */
  items: () => readonly StoredItem[];
  /** The AI analysis of one word. */
  analyze: (word: string) => Promise<{ vocabs?: VocabCard[] }>;
  /** Saves one new card. */
  save: (item: StoredItem) => void;
  /** Hears how far the import has got: once before the first word, then after each word. */
  report: (progress: BatchImportProgress) => void;
  /** Waits between attempts and words; tests pass one that doesn't. */
  sleep?: (ms: number) => Promise<void>;
}

// Words analyzed at once.
const BATCH_CONCURRENCY = 5;
// A failed word waits this long before its one retry, and this much longer when it was rate limited.
const RETRY_DELAY_MS = 2_000;
const RATE_LIMIT_DELAY_MS = 3_000;
// Each worker pauses between words, to stay clear of the rate limit.
const BETWEEN_WORDS_MS = 300;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Analyzes the listed words and saves each new meaning as a card. A word already saved is skipped, and a word
 * listed twice is analyzed once; a meaning that two listed words both produce is saved once. Each word is
 * tried twice before it counts as failed.
 */
export async function runBatchImport(
  words: readonly string[],
  { items, analyze, save, report, sleep = wait }: BatchImportJob,
): Promise<BatchImportOutcome> {
  // The saved words and senses, looked up once rather than scanned per word, and kept current as this import
  // saves more, so a sense that two listed words both produce is saved once.
  const savedWords = new Set<string>();
  const savedSenses = new Set<string>();
  for (const item of items()) {
    if (item.isDeleted || !isVocabItem(item)) continue;
    savedWords.add((item.data.word || '').toLowerCase().trim());
    savedSenses.add(savedVocabKey(item.data));
  }
  const listed = new Set<string>();
  const newWords: string[] = [];
  let skipped = 0;
  for (const word of words) {
    const w = word.toLowerCase().trim();
    if (listed.has(w)) continue;
    listed.add(w);
    if (savedWords.has(w)) skipped++;
    else newWords.push(word);
  }

  if (newWords.length === 0) return { kind: 'all-saved', listed: listed.size };

  report({ current: 0, total: newWords.length, skipped, failed: 0, saved: 0, isRunning: true });

  let completed = 0;
  let failed = 0;
  let saved = 0;
  let index = 0;
  const failedWords: string[] = [];
  const importedIds: string[] = [];

  const processWords = async () => {
    while (index < newWords.length) {
      const word = newWords[index++];

      // Retry once on failure (with backoff for rate limiting)
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            log(`Batch import: retrying "${word}" (attempt ${attempt + 1})`);
            await sleep(RETRY_DELAY_MS);
          }

          const result = await analyze(word);

          for (const vocab of result.vocabs || []) {
            const senseKey = savedVocabKey(vocab);
            if (!savedSenses.has(senseKey)) {
              savedSenses.add(senseKey);
              save(makeVocabStoredItem(vocab));
              saved++;
              importedIds.push(vocab.id);

              // Advanced metadata and images are added by the Mac-local enrichment cycle.
            }
          }
          lastError = null;
          break; // success — exit retry loop
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : '';
          // Back off extra on rate limiting before retry
          if (msg.includes('429') || msg.includes('QUOTA')) {
            await sleep(RATE_LIMIT_DELAY_MS);
          }
        }
      }

      if (lastError) {
        warn(`Batch import failed for "${word}":`, lastError instanceof Error ? lastError.message : '');
        failed++;
        failedWords.push(word);
      }

      completed++;
      report({ current: completed, total: newWords.length, skipped, failed, saved, isRunning: true });

      // Brief delay between requests to reduce rate limiting
      await sleep(BETWEEN_WORDS_MS);
    }
  };

  // Launch concurrent workers
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, newWords.length) }, () => processWords()));

  return { kind: 'done', saved, skipped, failed, failedWords, importedIds };
}
