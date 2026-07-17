import { HttpError } from './http';

export interface PendingSearchRetry {
  query: string;
  analyzeMode?: 'batch';
}

const SEARCH_RETRY_KEY = 'dictprop_pending_search_retry';
type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const getSessionStorage = (): SessionStorageLike | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function isAuthenticationError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 401;
}

export function rememberSearchRetry(retry: PendingSearchRetry, storage: SessionStorageLike | null = getSessionStorage()): void {
  if (!storage || !retry.query.trim()) return;
  try {
    storage.setItem(SEARCH_RETRY_KEY, JSON.stringify(retry));
  } catch {
    // Session storage is a convenience; the failed in-memory queue remains retryable.
  }
}

export function consumeSearchRetry(storage: SessionStorageLike | null = getSessionStorage()): PendingSearchRetry | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SEARCH_RETRY_KEY);
    storage.removeItem(SEARCH_RETRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSearchRetry;
    if (!parsed || typeof parsed.query !== 'string' || !parsed.query.trim()) return null;
    return { query: parsed.query, ...(parsed.analyzeMode === 'batch' ? { analyzeMode: 'batch' as const } : {}) };
  } catch {
    return null;
  }
}

export function describeSearchError(query: string, error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return `Your session expired. Sign in again to retry "${query}".`;
    if (error.status === 429) {
      return error.responseBody.includes('QUOTA_EXCEEDED')
        ? 'The AI provider quota is exhausted. Please try again later.'
        : 'AI requests are arriving too quickly. Try again shortly.';
    }
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return `"${query}" could not be analyzed because the AI service is busy.`;
    }
    if (error.status >= 400 && error.status < 500 && error.responseBody) {
      return `Could not analyze "${query}": ${error.responseBody}`;
    }
  }

  const message = error instanceof Error ? error.message : '';
  if (message === 'QUOTA_EXCEEDED') return 'The AI provider quota is exhausted. Please try again later.';
  if (message.includes('timed out') || message.includes('504') || (error instanceof Error && error.name === 'AbortError')) {
    return `"${query}" timed out because the AI service is busy.`;
  }
  return `Could not analyze "${query}".`;
}
