/**
 * DeepInfra chat client for the AI routes.
 *
 * Every AI request runs inside one budget: the client's disconnect signal combined with an overall
 * deadline, so an abandoned or slow search stops spending model time instead of retrying for many
 * minutes. Output is bounded with max_tokens, a cut-off reply is its own error, and failures carry a
 * kind that maps to an accurate HTTP status. All outbound HTTP goes through proxyFetch.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { env } from './env.js';
import { proxyFetch, type FetchLike } from './proxy-fetch.js';

const DEEPINFRA_CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
/** The chat model every AI route asks; work that keeps what it said (the theme classifier) records it. */
export const DEEPSEEK_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const DEFAULT_TEMPERATURE = 0.7;
// One extra attempt for a transient failure (5xx, burst 429, network, malformed reply). Never for timeouts.
const TRANSIENT_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;
// A retry that cannot get this long a window would only turn the real error into a timeout.
const MIN_RETRY_WINDOW_MS = 15_000;
// Nginx's "client closed request": the caller is gone, so the status is only for logs.
const CLIENT_CLOSED_REQUEST = 499;

export type AiErrorKind =
  | 'quota'          // provider balance exhausted (402, or 429 naming billing)
  | 'rate_limited'   // provider burst limit (429)
  | 'unavailable'    // provider 5xx or unreachable
  | 'timeout'        // our budget, a per-call window, or an undici/curl timeout
  | 'cancelled'      // the client disconnected
  | 'truncated'      // finish_reason "length": the reply hit max_tokens
  | 'invalid'        // unusable content (not JSON, wrong shape, failed validation)
  | 'not_found'      // the model reports no dictionary entry for the input
  | 'auth'           // no key, or the provider refuses it (401, 403)
  | 'config'         // a request the provider rejects (any other 4xx)
  | 'internal';

export class AiError extends Error {
  readonly kind: AiErrorKind;

  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}

/** Classify a non-2xx provider response. A 429 whose body names billing is an exhausted balance, not a burst limit. */
export function providerError(status: number, bodyText: string): AiError {
  if (status === 402 || (status === 429 && /quota|insufficient|balance|billing|payment|credit/i.test(bodyText))) {
    return new AiError('quota', `Provider quota exhausted (${status})`);
  }
  if (status === 429) return new AiError('rate_limited', `Provider rate limit (${status})`);
  if (status >= 500) return new AiError('unavailable', `Provider unavailable (${status})`);
  if (status === 401 || status === 403) {
    return new AiError('auth', `Provider refused the key (${status}): ${bodyText.slice(0, 200)}`);
  }
  return new AiError('config', `Provider rejected the request (${status}): ${bodyText.slice(0, 200)}`);
}

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

/** The parts of a thrown fetch, undici or curl error that tell a timeout from a network failure. */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: { code?: unknown; cause?: { code?: unknown } };
}

/** Map any failure from a model call to an AiError. A disconnected client wins over whatever the abort looked like. */
export function classifyAiError(error: unknown, clientSignal?: AbortSignal): AiError {
  if (error instanceof AiError) return error;
  if (clientSignal?.aborted) return new AiError('cancelled', 'The client closed the request');
  const err = error as ErrorLike | null | undefined;
  const codes = [err?.code, err?.cause?.code, err?.cause?.cause?.code].filter(Boolean);
  const message = String(err?.message ?? error ?? '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' ||
      codes.some(code => TIMEOUT_CODES.has(String(code))) || /curl exited 28\b/.test(message)) {
    return new AiError('timeout', 'The AI service timed out');
  }
  if (codes.some(code => NETWORK_CODES.has(String(code))) || message === 'fetch failed' || /curl exited (?:6|7|35|52|56)\b/.test(message)) {
    return new AiError('unavailable', `The AI service is unreachable: ${message}`);
  }
  return new AiError('internal', message || 'Unexpected AI failure');
}

export function aiErrorStatus(error: AiError): number {
  switch (error.kind) {
    case 'quota':
    case 'rate_limited': return 429;
    case 'unavailable': return 503;
    case 'timeout': return 504;
    case 'cancelled': return CLIENT_CLOSED_REQUEST;
    case 'truncated':
    case 'invalid': return 502;
    case 'not_found': return 422;
    default: return 500;
  }
}

export interface AiErrorMessages {
  /** Log prefix, e.g. "Analysis". */
  label: string;
  failed: string;
  timeout?: string;
  notFound?: string;
}

/** The { error, status } body the client already parses; QUOTA_EXCEEDED and RATE_LIMITED are machine-readable tokens. */
export function aiErrorBody(error: AiError, messages: AiErrorMessages): { error: string; status: number } {
  const status = aiErrorStatus(error);
  switch (error.kind) {
    case 'quota': return { error: 'QUOTA_EXCEEDED', status };
    case 'rate_limited': return { error: 'RATE_LIMITED', status };
    case 'unavailable': return { error: 'The AI service is temporarily unavailable. Please try again.', status };
    case 'timeout': return { error: messages.timeout ?? 'The AI service timed out. Please try again.', status };
    case 'cancelled': return { error: 'Request cancelled.', status };
    case 'truncated': return { error: 'The AI response was cut off before it finished. Please try again.', status };
    case 'invalid': return { error: 'The AI returned an unusable response. Please try again.', status };
    case 'not_found': return { error: messages.notFound ?? 'No dictionary entry found.', status };
    default: return { error: messages.failed, status };
  }
}

export function aiErrorResponse(c: Context, error: unknown, messages: AiErrorMessages, clientSignal?: AbortSignal) {
  const aiError = classifyAiError(error, clientSignal);
  const body = aiErrorBody(aiError, messages);
  if (aiError.kind === 'cancelled' || aiError.kind === 'not_found') {
    console.log(`${messages.label}: ${aiError.message}`);
  } else {
    console.error(`${messages.label} failed (${aiError.kind}): ${aiError.message}`);
  }
  return c.json(body, body.status as ContentfulStatusCode);
}

export interface AiRequestContext {
  /** Aborts when the HTTP client disconnects. */
  clientSignal?: AbortSignal;
  /** Aborts on disconnect or when the overall budget runs out. */
  signal: AbortSignal;
  deadlineAt: number;
}

export function createRequestContext(clientSignal: AbortSignal | undefined, budgetMs: number): AiRequestContext {
  const budget = AbortSignal.timeout(budgetMs);
  return {
    clientSignal,
    signal: clientSignal ? AbortSignal.any([clientSignal, budget]) : budget,
    deadlineAt: Date.now() + budgetMs,
  };
}

export const remainingMs = (ctx: AiRequestContext): number => Math.max(0, ctx.deadlineAt - Date.now());

export interface ChatRequest {
  system: string;
  user: string;
  /** The reply's token cap; with reasoning on, the model's thinking counts toward it too. */
  maxTokens: number;
  temperature?: number;
  /** Turns on the model's thinking first (DeepInfra's reasoning_effort): slower, and better at careful judgments. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  label?: string;
}

export interface JsonChatRequest<T> extends ChatRequest {
  /**
   * Turns the reply object into the caller's result, throwing AiError('invalid') for a reply it can't use. That
   * throw happens inside the client, which retries it once, as it does a reply that isn't JSON.
   */
  accept?: (reply: Record<string, unknown>) => T;
}

/** One JSON-object reply from the chat model (or what `accept` makes of it), or an AiError. */
export type ChatJson = <T = Record<string, unknown>>(ctx: AiRequestContext, request: JsonChatRequest<T>) => Promise<T>;

/** One plain-text reply from the chat model, or an AiError. */
export type ChatText = (ctx: AiRequestContext, request: ChatRequest) => Promise<string>;

/** The parts of a chat-completion response the client reads. */
interface ChatEnvelope {
  error?: unknown;
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
}

export interface ChatClientOptions {
  fetch?: FetchLike;
  apiKey?: () => string | undefined;
  retryDelayMs?: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The JSON object in a model reply, or an 'invalid' AiError (which the client retries once). */
function parseJsonObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseModelJson(content);
  } catch (error) {
    throw new AiError('invalid', (error instanceof Error && error.message) || 'Failed to parse JSON from DeepSeek response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError('invalid', 'DeepSeek returned JSON that is not an object');
  }
  return parsed as Record<string, unknown>;
}

type ReplyFormat = 'json' | 'text';

/**
 * Calls the chat model inside the request's budget and turns its reply into a result with `parse`: one request,
 * plus one retry of a transient failure. In JSON mode the model is asked for a JSON object.
 */
function createChatCaller(options: ChatClientOptions) {
  const doFetch = options.fetch ?? proxyFetch;
  const apiKey = options.apiKey ?? (() => env.DEEPINFRA_API_KEY);
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  /** One request; resolves the reply's content. */
  async function callOnce(ctx: AiRequestContext, request: ChatRequest, format: ReplyFormat, withMaxTokens: boolean): Promise<string> {
    const key = apiKey();
    if (!key) throw new AiError('auth', 'DEEPINFRA_API_KEY not configured');
    ctx.signal.throwIfAborted();
    // A call may use whatever is left of the request's budget.
    const window = remainingMs(ctx);
    if (window <= 0) throw new AiError('timeout', 'The request budget is exhausted');
    const label = request.label ?? 'chat';
    console.log(`DeepSeek ${label}: calling API (window ${window}ms, max_tokens ${withMaxTokens ? request.maxTokens : 'default'})`);
    const response = await doFetch(DEEPINFRA_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
        ...(format === 'json' ? { response_format: { type: 'json_object' } } : {}),
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        ...(withMaxTokens ? { max_tokens: request.maxTokens } : {}),
      }),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(window)]),
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(`DeepSeek ${label} error ${response.status}: ${text.slice(0, 300)}`);
      // A provider that caps output below our max_tokens rejects the whole call; fall back to its default cap.
      if (withMaxTokens && response.status === 400 && /max[_ ]?(?:completion[_ ]?)?tokens/i.test(text)) {
        return callOnce(ctx, request, format, false);
      }
      throw providerError(response.status, text);
    }
    let data: ChatEnvelope | null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AiError('invalid', 'DeepSeek returned a non-JSON envelope');
    }
    if (data?.error) throw new AiError('unavailable', `DeepSeek error: ${JSON.stringify(data.error).slice(0, 200)}`);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new AiError('truncated', `DeepSeek ${label} reply hit max_tokens (${withMaxTokens ? request.maxTokens : 'default'})`);
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiError('invalid', 'DeepSeek returned empty response');
    return content;
  }

  return async function call<T>(ctx: AiRequestContext, request: ChatRequest, format: ReplyFormat, parse: (content: string) => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let failure: AiError;
      try {
        return parse(await callOnce(ctx, request, format, true));
      } catch (error) {
        failure = classifyAiError(error, ctx.clientSignal);
      }
      // Retry fast transient failures only. A timeout already burned its window, a cut-off reply would be
      // cut off again, and quota, auth and config errors do not change on a retry.
      const retryable = failure.kind === 'unavailable' || failure.kind === 'rate_limited' || failure.kind === 'invalid';
      if (!retryable || attempt >= TRANSIENT_RETRIES || ctx.signal.aborted || remainingMs(ctx) < retryDelayMs + MIN_RETRY_WINDOW_MS) {
        throw failure;
      }
      console.warn(`DeepSeek ${request.label ?? 'chat'} attempt ${attempt + 1} failed (${failure.kind}: ${failure.message}); retrying`);
      try {
        await abortableDelay(retryDelayMs, ctx.signal);
      } catch (error) {
        throw classifyAiError(error, ctx.clientSignal);
      }
    }
  };
}

export function createChatClient(options: ChatClientOptions = {}): ChatJson {
  const call = createChatCaller(options);
  // Without `accept`, T is its default, the reply object itself.
  return <T>(ctx: AiRequestContext, request: JsonChatRequest<T>) => call(ctx, request, 'json', (content): T => {
    const reply = parseJsonObject(content);
    return request.accept ? request.accept(reply) : reply as T;
  });
}

/** A chat client for plain-text replies: the same request, envelope handling and retry, no JSON mode. */
export function createChatTextClient(options: ChatClientOptions = {}): ChatText {
  const call = createChatCaller(options);
  return (ctx, request) => call(ctx, request, 'text', content => content);
}

// ============================================================================
// Model JSON extraction
// ============================================================================

// Each balanced top-level {...} in the text. Quotes are tracked only inside an object, so an
// apostrophe or quote in surrounding prose cannot hide a brace.
function balancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) objects.push(text.slice(start, i + 1));
    }
  }
  return objects;
}

// Remove commas that directly precede } or ] outside strings (a common model slip).
function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === ',') {
      let next = i + 1;
      while (next < json.length && /\s/.test(json[next])) next++;
      if (json[next] === '}' || json[next] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Extract the JSON value from a model reply. The whole reply is tried first, so a ``` fence or a
 * brace inside a JSON string cannot derail a valid answer; then a ``` fence; then each balanced
 * top-level object, largest first (a short draft before the answer loses); then the outermost
 * {...} slice. Every candidate is retried once with trailing commas removed.
 */
export function parseModelJson(content: string): unknown {
  const text = content.trim();
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(...balancedObjects(text).sort((a, b) => b.length - a.length));
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const repair of [false, true]) {
    for (const candidate of candidates) {
      try {
        return JSON.parse(repair ? stripTrailingCommas(candidate) : candidate);
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error('Failed to parse JSON from DeepSeek response');
}
