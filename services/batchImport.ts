import { isVocabItem, type StoredItem, type VocabCard } from '../types';
import { runPool } from '../server/src/shared/pool';
import { log, warn } from './logger';
import { saveNewSenses, savedSenseKeys } from './senseSaving';

/** How far a batch import has got, while it runs. */
export interface BatchImportProgress { current: number; total: number; skipped: number; failed: number; saved: number }

/**
 * What an import that ran did. `added` counts the listed words that gained a card and `saved` the cards (one word can
 * bring several meanings), whose ids `importedIds` lists; `skipped` counts the listed words already saved, and `failed`
 * those whose analysis kept failing, which `failedWords` lists.
 */
export interface BatchImportTally {
  added: number;
  saved: number;
  skipped: number;
  failed: number;
  failedWords: string[];
  importedIds: string[];
}

/** How a batch import ended: every listed word was already saved, or it's done, or it stopped before its last words. */
export type BatchImportOutcome =
  | { kind: 'all-saved'; listed: number }
  | ({ kind: 'done' | 'stopped' } & BatchImportTally);

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
  /** Stops the import: once it's aborted no word starts, and the words under way finish. */
  signal?: AbortSignal;
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
 * tried twice before it counts as failed. An aborted `signal` stops it after the words under way.
 */
export async function runBatchImport(
  words: readonly string[],
  { items, analyze, save, report, sleep = wait, signal }: BatchImportJob,
): Promise<BatchImportOutcome> {
  // The saved words and senses, looked up once rather than scanned per word, and kept current as this import
  // saves more, so a sense that two listed words both produce is saved once (services/senseSaving).
  const library = items();
  const savedWords = new Set<string>();
  for (const item of library) {
    if (!item.isDeleted && isVocabItem(item)) savedWords.add((item.data.word || '').toLowerCase().trim());
  }
  const savedSenses = savedSenseKeys(library);
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

  report({ current: 0, total: newWords.length, skipped, failed: 0, saved: 0 });

  let completed = 0;
  let failed = 0;
  let saved = 0;
  let added = 0;
  const failedWords: string[] = [];
  const importedIds: string[] = [];

  // The words in order, a few at a time, on the shared pool: once the signal aborts no word starts.
  await runPool(newWords, BATCH_CONCURRENCY, async word => {
    // Retry once on failure (with backoff for rate limiting)
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          log(`Batch import: retrying "${word}" (attempt ${attempt + 1})`);
          await sleep(RETRY_DELAY_MS);
        }

        const result = await analyze(word);

        // Advanced metadata and images are added by the Mac-local enrichment cycle.
        const newSenses = saveNewSenses(result.vocabs || [], savedSenses, save);
        for (const vocab of newSenses) {
          saved++;
          importedIds.push(vocab.id);
        }
        if (newSenses.length > 0) added++;
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
    report({ current: completed, total: newWords.length, skipped, failed, saved });

    // Brief delay between requests to reduce rate limiting; a stopped import has no next request.
    if (!signal?.aborted) await sleep(BETWEEN_WORDS_MS);
  }, signal);

  // A stop that came once every word had started changed nothing: the import is done.
  const kind = completed < newWords.length ? 'stopped' : 'done';
  return { kind, added, saved, skipped, failed, failedWords, importedIds };
}
