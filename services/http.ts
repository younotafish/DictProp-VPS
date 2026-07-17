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

export async function responseToHttpError(response: Response, label = 'Request'): Promise<HttpError> {
  const body = await readErrorBody(response);
  const detail = body ? `: ${body}` : '';
  const error = new HttpError(`${label} failed (${response.status})${detail}`, response.status, body);
  notifyAuthRequired(error);
  return error;
}

export async function assertResponseOk(response: Response, label: string): Promise<void> {
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

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  label = 'Request',
): Promise<T> {
  const response = await fetch(url, init);
  await assertResponseOk(response, label);
  return response.json() as Promise<T>;
}

export async function requestVoid(
  url: string,
  init?: RequestInit,
  label = 'Request',
): Promise<void> {
  const response = await fetch(url, init);
  await assertResponseOk(response, label);
}
