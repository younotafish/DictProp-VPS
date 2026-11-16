import type { NoticeTone } from '../components/NoticePill';
import type { BatchImportOutcome } from './batchImport';

/**
 * What a background job says when it ends: a pill in the notice stack (components/JobPills), never a dialog, since
 * none of it asks for a decision. Its texts load with the notebook tools (services/libraryTools), so they stay out of
 * the app's first chunk; elsewhere only `import type` from here.
 */

/** A job's result as its pill shows it. */
export interface JobNotice {
  text: string;
  tone: NoticeTone;
  /** How long it shows; null keeps it until it's dismissed or another result replaces it. */
  timeoutMs: number | null;
  /** The words the pill's Retry imports again. */
  retryWords?: string[];
}

/** A count as the pills show it: 1,200. */
export const count = (n: number): string => n.toLocaleString('en-US');
const words = (n: number): string => `${count(n)} ${n === 1 ? 'word' : 'words'}`;

/** What a batch import says when it ends. */
export function describeBatchResult(outcome: BatchImportOutcome): JobNotice {
  if (outcome.kind === 'all-saved') {
    const text = outcome.listed === 1 ? 'That word is already saved' : `All ${words(outcome.listed)} are already saved`;
    return { text, tone: 'emerald', timeoutMs: 3_000 };
  }
  const { added, skipped, failed, failedWords } = outcome;
  if (outcome.kind === 'stopped') return { text: `Stopped · added ${words(added)}`, tone: 'dark', timeoutMs: 4_000 };
  if (failed > 0) return { text: `Couldn’t add ${words(failed)}`, tone: 'rose', timeoutMs: null, retryWords: failedWords };
  const alreadySaved = skipped > 0 ? ` · ${count(skipped)} already saved` : '';
  return { text: `${added > 0 ? `Added ${words(added)}` : 'Nothing new to add'}${alreadySaved}`, tone: 'emerald', timeoutMs: 4_000 };
}
