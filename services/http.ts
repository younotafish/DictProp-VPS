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

async function assertOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const body = await readErrorBody(response);
  const detail = body ? `: ${body}` : '';
  throw new HttpError(`${label} failed (${response.status})${detail}`, response.status, body);
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
  await assertOk(response, label);
  return response.json() as Promise<T>;
}

export async function requestVoid(
  url: string,
  init?: RequestInit,
  label = 'Request',
): Promise<void> {
  const response = await fetch(url, init);
  await assertOk(response, label);
}
