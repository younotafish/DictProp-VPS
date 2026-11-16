import { defaultSessionStorage, parseJson, type StorageLike } from './browserStorage';
import { HttpError } from './http';

export interface PendingSearchRetry {
  query: string;
  analyzeMode?: 'batch';
}

const SEARCH_RETRY_KEY = 'dictprop_pending_search_retry';

export function isAuthenticationError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 401;
}

/**
 * Whether sending the same search again could succeed. Another request error (a word the model doesn't
 * know, an input the server refuses) gets the same answer every time; a session, a rate limit or the
 * provider can recover.
 */
export function isRetryableSearchError(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status < 400 || error.status >= 500) return true;
  return error.status === 401 || error.status === 408 || error.status === 429;
}

export function rememberSearchRetry(retry: PendingSearchRetry, storage: StorageLike | null = defaultSessionStorage()): void {
  if (!storage || !retry.query.trim()) return;
  try {
    storage.setItem(SEARCH_RETRY_KEY, JSON.stringify(retry));
  } catch {
    // Session storage is a convenience; the failed in-memory queue remains retryable.
  }
}

export function consumeSearchRetry(storage: StorageLike | null = defaultSessionStorage()): PendingSearchRetry | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SEARCH_RETRY_KEY);
    storage.removeItem(SEARCH_RETRY_KEY);
    if (!raw) return null;
    const parsed = parseJson(raw) as PendingSearchRetry | null;
    if (!parsed || typeof parsed.query !== 'string' || !parsed.query.trim()) return null;
    return { query: parsed.query, ...(parsed.analyzeMode === 'batch' ? { analyzeMode: 'batch' as const } : {}) };
  } catch {
    return null;
  }
}

/** What a search error is about: a lookup's query, a comparison's "a vs b", or the text a scan read. */
export interface SearchSubject {
  kind: 'analysis' | 'comparison' | 'scan';
  label: string;
}

/** The longest stretch of a query an error quotes; a longer one is cut there and ends in an ellipsis. */
const QUOTE_LIMIT = 40;

/** `label` as an error quotes it: on one line, at most QUOTE_LIMIT characters, in curly quotes. */
const quote = (label: string): string => {
  const chars = Array.from(label.replace(/\s+/g, ' ').trim());
  return `“${chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('').trimEnd()}…` : chars.join('')}”`;
};

/** Whether the request never reached DictProp: fetch's TypeError, as thrown or as the cause of an error wrapping it. */
export function isNetworkFailure(error: unknown): boolean {
  for (let at = error, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) {
    if (at instanceof TypeError) return true;
  }
  return false;
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const VERB: Record<SearchSubject['kind'], string> = { analysis: 'analyze', comparison: 'compare', scan: 'scan' };

/**
 * What the search says about a failed lookup, comparison or scan, quoting at most 40 characters of what it was about.
 * A request that never reached DictProp says so, a timeout says so, and the server's statuses keep their own words.
 * The toast offers the retry itself, when there is one to offer, so no message asks for it.
 *
 * Given a plain query (the form components/search/runLookup.ts and the Notebook's AI box still use), it keeps the
 * wording it had before subjects existed; both move to a subject with their next owner, and the form goes then.
 */
export function describeSearchError(subject: SearchSubject, error: unknown): string;
export function describeSearchError(query: string, error: unknown): string;
export function describeSearchError(subject: SearchSubject | string, error: unknown): string {
  if (typeof subject === 'string') return describeQueryError(subject, error);
  const { kind } = subject;
  const label = quote(subject.label);
  if (error instanceof HttpError) {
    if (error.status === 401) return `Your session expired. Sign in again to retry ${label}.`;
    if (error.status === 429) {
      return error.responseBody.includes('QUOTA_EXCEEDED')
        ? 'The AI provider quota is exhausted. Please try again later.'
        : 'The AI provider rate-limited this request. Try again shortly.';
    }
    if (error.status === 502) {
      return kind === 'scan' ? 'The model found no usable expressions in this text.'
        : `The model returned no usable ${kind === 'comparison' ? 'comparison' : 'definition'} for ${label}.`;
    }
    if (error.status === 503) return `The AI provider is temporarily unavailable for ${label}.`;
    if (error.status === 504) return `The model did not finish ${label} before the timeout.`;
    // The model judged the input not to be a word (a typo or keyboard noise); retrying won't help.
    if (error.status === 422) return `No dictionary entry found for ${label}. Check the spelling and try again.`;
    if (error.status >= 400 && error.status < 500 && error.responseBody) {
      return `Could not ${VERB[kind]} ${label}: ${error.responseBody}`;
    }
  }
  if (error instanceof Error && error.message === 'QUOTA_EXCEEDED') return 'The AI provider quota is exhausted. Please try again later.';
  if (isTimeout(error)) return `The model did not finish ${label} before the timeout.`;
  if (isNetworkFailure(error)) return kind === 'scan' ? `Couldn’t reach DictProp to scan ${label}.` : `Couldn’t reach DictProp for ${label}.`;
  return `Could not ${VERB[kind]} ${label}.`;
}

/** A failed lookup, comparison or scan, as the search keeps it until it's retried, edited or dismissed. */
export interface SearchFailure {
  message: string;
  /** Sending the same request again could succeed (see isRetryableSearchError). */
  retryable: boolean;
  /** The model found no dictionary entry for the query (a 422), so editing it is the way on, not retrying. */
  notAWord: boolean;
  /** When it failed. */
  at: number;
}

/** The failure the search keeps for `error`, which happened at `at` to a request about `subject`. */
export const failureOf = (subject: SearchSubject, error: unknown, at: number): SearchFailure => ({
  message: describeSearchError(subject, error),
  retryable: isRetryableSearchError(error),
  notAWord: error instanceof HttpError && error.status === 422,
  at,
});

/** describeSearchError for a plain query, worded as it was before subjects. */
function describeQueryError(query: string, error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return `Your session expired. Sign in again to retry "${query}".`;
    if (error.status === 429) {
      return error.responseBody.includes('QUOTA_EXCEEDED')
        ? 'The AI provider quota is exhausted. Please try again later.'
        : 'The AI provider rate-limited this request. Try again shortly.';
    }
    // The toast offers the retry itself, when there is one to offer.
    if (error.status === 502) return `The model returned no usable definition for "${query}".`;
    if (error.status === 503) return `The AI provider is temporarily unavailable for "${query}".`;
    if (error.status === 504) return `The model did not finish "${query}" before the timeout.`;
    // The model judged the input not to be a word (a typo or keyboard noise); retrying won't help.
    if (error.status === 422) return `No dictionary entry found for "${query}". Check the spelling and try again.`;
    if (error.status >= 400 && error.status < 500 && error.responseBody) {
      return `Could not analyze "${query}": ${error.responseBody}`;
    }
  }

  const message = error instanceof Error ? error.message : '';
  if (message === 'QUOTA_EXCEEDED') return 'The AI provider quota is exhausted. Please try again later.';
  if (message.includes('timed out') || message.includes('504') || (error instanceof Error && error.name === 'AbortError')) {
    return `The model did not finish "${query}" before the timeout.`;
  }
  return `Could not analyze "${query}".`;
}
