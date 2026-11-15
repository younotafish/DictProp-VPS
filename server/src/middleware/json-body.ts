import type { Context } from 'hono';

const parse = (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

/** The request's JSON body when it is an object (not an array), or null for anything else, malformed JSON included. */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const body = await parse(c);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

/** The request's JSON body when it is an array, or null for anything else, malformed JSON included. */
export async function readJsonArray(c: Context): Promise<unknown[] | null> {
  const body = await parse(c);
  return Array.isArray(body) ? body : null;
}
