export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const AUTH_REQUIRED_EVENT = 'dictprop:auth-required';

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';

  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = data.error ?? data.message;
    return typeof message === 'string' ? message : text;
  } catch {
    return text;
  }
}

function notifyAuthRequired(error: HttpError): void {
  if (error.status !== 401 || typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, {
    detail: { status: error.status, message: error.responseBody },
  }));
}

async function responseToHttpError(response: Response, label = 'Request'): Promise<HttpError> {
  const body = await readErrorBody(response);
  const detail = body ? `: ${body}` : '';
  const error = new HttpError(`${label} failed (${response.status})${detail}`, response.status, body);
  notifyAuthRequired(error);
  return error;
}

async function assertResponseOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  throw await responseToHttpError(response, label);
}

export function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// fetch() never times out on its own. A wedged mobile socket would otherwise hold the delta-pull,
// review-flush and force-sync guards until the page reloads, so bound the headers and body together.
const REQUEST_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  init: RequestInit | undefined,
  timeoutMs: number,
  run: (init: RequestInit) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const callerSignal = init?.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await run({ ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * fetch() given `timeoutMs` for the headers and `read`, which reads what it needs of the body. A request that runs
 * out of time rejects with a TimeoutError. It never checks the status or reports a lapsed sign-in: `read` decides
 * what a response means. For requests whose failures the caller handles itself (pictures, audio, the sign-in check).
 */
export async function fetchWithin<T>(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  return withTimeout(init, timeoutMs, async (timedInit) => read(await fetch(url, timedInit)));
}

/** A JSON request: a failed status throws an HttpError (a 401 also reports the lapsed sign-in), else the body. */
export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  label = 'Request',
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return fetchWithin(url, init, timeoutMs, async (response) => {
    await assertResponseOk(response, label);
    return await response.json() as T;
  });
}

/** A request whose reply has no body to read: a failed status throws as in requestJson. */
export async function requestVoid(
  url: string,
  init?: RequestInit,
  label = 'Request',
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  return fetchWithin(url, init, timeoutMs, async (response) => {
    await assertResponseOk(response, label);
  });
}
