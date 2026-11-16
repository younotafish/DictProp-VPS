import { comparisonKey } from '../types';
import { defaultSessionStorage, parseJson, type StorageLike } from './browserStorage';
import { HttpError } from './http';
import { PENDING_REQUESTS_KEY, SEARCH_RETRIES_KEY } from './searchSessionKeys';

/**
 * A request the search runs, as data: what is kept when a session expires, for running it again after signing in, and
 * across a reload. Queries and modes only: never a result, nor the sentence a lookup came from.
 */
export type SearchRequest =
  | { kind: 'scan'; query: string }
  | { kind: 'analyze'; query: string; analyzeMode?: 'batch'; forceAI?: boolean }
  | { kind: 'compare'; words: string[] };

/** At most this many requests are kept for later, the newest: to run after signing in again, and across a reload. */
const MAX_KEPT = 20;

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isQuery = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** `value` as a well-formed search request, holding only a request's fields, or null. */
function searchRequestOf(value: unknown): SearchRequest | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'scan') return isQuery(value.query) ? { kind: 'scan', query: value.query } : null;
  if (value.kind === 'analyze') {
    if (!isQuery(value.query)) return null;
    return {
      kind: 'analyze',
      query: value.query,
      ...(value.analyzeMode === 'batch' ? { analyzeMode: 'batch' as const } : {}),
      ...(value.forceAI === true ? { forceAI: true } : {}),
    };
  }
  if (value.kind === 'compare') {
    const words = Array.isArray(value.words) ? value.words.filter(isQuery) : [];
    return words.length >= 2 ? { kind: 'compare', words } : null;
  }
  return null;
}

/**
 * Which request `request` is, so that each runs once: its kind, and its query, whatever its case, the spaces around it
 * or its mode, or the words it compares, in any order.
 */
export const searchRequestKey = (request: SearchRequest): string =>
  request.kind === 'compare' ? `compare ${comparisonKey(request.words)}` : `${request.kind} ${request.query.trim().toLowerCase()}`;

/**
 * The requests kept to run after signing in again, the newest MAX_KEPT; anything malformed is skipped. Builds before
 * the list kept one request, and builds before search requests existed kept a lookup as { query, analyzeMode }, to run
 * again as a refresh; each is still read, as a list of one, since an OAuth redirect can straddle a deploy.
 */
function decodeSearchRetries(raw: string | null): SearchRequest[] {
  const parsed = parseJson(raw);
  const entries: unknown[] = Array.isArray(parsed) ? parsed.slice(-MAX_KEPT)
    : isRecord(parsed) && !('kind' in parsed) ? [{ kind: 'analyze', query: parsed.query, analyzeMode: parsed.analyzeMode, forceAI: true }]
    : [parsed];
  return entries.flatMap(entry => {
    const request = searchRequestOf(entry);
    return request ? [request] : [];
  });
}

/**
 * Keeps `request`, whose session expired, to run once the user signs in again (the OAuth redirect keeps sessionStorage),
 * with the others a session's end cut off: the newest MAX_KEPT, and each request once (see searchRequestKey).
 */
export function rememberSearchRetry(request: SearchRequest, storage: StorageLike | null = defaultSessionStorage()): void {
  const kept = searchRequestOf(request);
  if (!storage || !kept) return;
  try {
    const retries = decodeSearchRetries(storage.getItem(SEARCH_RETRIES_KEY));
    const key = searchRequestKey(kept);
    if (retries.some(retry => searchRequestKey(retry) === key)) return;
    storage.setItem(SEARCH_RETRIES_KEY, JSON.stringify([...retries, kept].slice(-MAX_KEPT)));
  } catch {
    // Session storage is a convenience: the failure stays in the queue, where Retry reaches it until the page goes.
  }
}

/** The requests kept to run after signing in again, in the order they were kept, once: reading them forgets them. */
export function consumeSearchRetries(storage: StorageLike | null = defaultSessionStorage()): SearchRequest[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SEARCH_RETRIES_KEY);
    storage.removeItem(SEARCH_RETRIES_KEY);
    return decodeSearchRetries(raw);
  } catch {
    return [];
  }
}

/** A request still waiting on its result, or whose result hasn't been seen, and when it was asked for. */
export interface PendingRequest {
  request: SearchRequest;
  at: number;
}

/** A request older than this isn't run again after a reload. */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

/** The newest MAX_KEPT of `pending`, as search_pending_v1 keeps them. */
export function encodePendingRequests(pending: readonly PendingRequest[]): string {
  return JSON.stringify(pending.slice(-MAX_KEPT).flatMap(({ request, at }) => {
    const kept = searchRequestOf(request);
    return kept ? [{ request: kept, at }] : [];
  }));
}

/** The requests search_pending_v1 kept, asked for within the last hour before `now`; anything malformed is skipped. */
export function decodePendingRequests(raw: string | null, now: number): SearchRequest[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-MAX_KEPT).flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.at !== 'number' || !(entry.at <= now && now - entry.at < PENDING_MAX_AGE_MS)) return [];
    const request = searchRequestOf(entry.request);
    return request ? [request] : [];
  });
}

/** Keeps `pending` for after a reload (sessionStorage lasts as long as the tab), or forgets the list when it's empty. */
export function writePendingRequests(pending: readonly PendingRequest[], storage: StorageLike | null = defaultSessionStorage()): void {
  if (!storage) return;
  try {
    if (pending.length === 0) storage.removeItem(PENDING_REQUESTS_KEY);
    else storage.setItem(PENDING_REQUESTS_KEY, encodePendingRequests(pending));
  } catch {
    // Session storage is a convenience: a reload then only loses the tray, as it always did.
  }
}

/** The requests kept from before a reload, as decodePendingRequests reads them. */
export function readPendingRequests(now: number, storage: StorageLike | null = defaultSessionStorage()): SearchRequest[] {
  if (!storage) return [];
  try {
    return decodePendingRequests(storage.getItem(PENDING_REQUESTS_KEY), now);
  } catch {
    return [];
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
 */
export function describeSearchError(subject: SearchSubject, error: unknown): string {
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
