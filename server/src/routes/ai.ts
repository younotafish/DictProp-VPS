// The AI routes: analysis of a word, phrase or sentence, vocabulary scans, comparisons and transcription. Each
// request runs inside one budget (shared/ai-limits.ts) through the chat client in ai-client.ts; the prompts, card
// generation and output sanitizing live in server/src/ai/.
import { Hono, type Context } from 'hono';
import { env } from '../env.js';
import { readJsonObject } from '../middleware/json-body.js';
import { proxyFetch, type FetchLike } from '../proxy-fetch.js';
import {
  AiError,
  aiErrorResponse,
  createChatClient,
  createRequestContext,
  providerError,
  type AiErrorMessages,
} from '../ai-client.js';
import { generateAnalysisData, routeQuery } from '../ai/analysis.js';
import { comparisonPrompts, vocabularyScanPrompts } from '../ai/prompts.js';
import { acceptComparison, acceptVocabularyScan, trimmedString, uniqueCompareWords } from '../ai/sanitize.js';
import {
  ANALYSIS_BUDGET_MS,
  COMPARE_BUDGET_MS,
  EXTRACT_BUDGET_MS,
  TRANSCRIBE_BUDGET_MS,
} from '../shared/ai-limits.js';
import { MAX_COMPARE_WORDS } from '../shared/query-mode.js';

// ============================================================================
// Limits (the request budgets live in shared/ai-limits.ts, where the client can read them too)
// ============================================================================

const COMPARE_MAX_TOKENS = 8_000;
const EXTRACT_MAX_TOKENS = 8_000;
// The longest text a request carries: /analyze refuses a longer one, /extract-vocabulary scans its beginning.
const MAX_INPUT_CHARS = 5000;

const DEEPINFRA_WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo';

// ============================================================================
// Error messages
// ============================================================================

const MISSING_KEY = 'DEEPINFRA_API_KEY not configured';

const ANALYSIS_ERRORS: AiErrorMessages = {
  label: 'Analysis',
  failed: 'Analysis failed. Please try again.',
  notFound: 'No dictionary entry found. Check the spelling and try again.',
};
const EXTRACT_ERRORS: AiErrorMessages = {
  label: 'Vocabulary detection',
  failed: 'Vocabulary detection failed. Please try again.',
  timeout: 'Timed out. Try a shorter text.',
};
const COMPARE_ERRORS: AiErrorMessages = {
  label: 'Comparison',
  failed: 'Comparison failed. Please try again.',
  timeout: 'Timed out. Please try again.',
};
const TRANSCRIBE_ERRORS: AiErrorMessages = { label: 'Transcription', failed: 'Transcription failed. Please try again.' };

function errorResponse(msg: string, status: number) {
  return { error: msg, status };
}

// ============================================================================
// Routes
// ============================================================================

export interface AiRouteDependencies {
  /** Outbound HTTP; proxyFetch unless a test injects a stub. */
  fetch?: FetchLike;
  apiKey?: () => string | undefined;
  retryDelayMs?: number;
  budgetsMs?: Partial<Record<'analyze' | 'compare' | 'extract' | 'transcribe', number>>;
}

/** What an AI route's handler works with. */
interface AiRequest {
  c: Context;
  /** The request's JSON body. */
  body: Record<string, unknown>;
  /** Aborts when the client disconnects. */
  clientSignal: AbortSignal;
  apiKey: string;
}

export function createAiRoutes(deps: AiRouteDependencies = {}) {
  const doFetch = deps.fetch ?? proxyFetch;
  const apiKey = deps.apiKey ?? (() => env.DEEPINFRA_API_KEY);
  const chat = createChatClient({ fetch: doFetch, apiKey, retryDelayMs: deps.retryDelayMs });
  const budgets = {
    analyze: deps.budgetsMs?.analyze ?? ANALYSIS_BUDGET_MS,
    compare: deps.budgetsMs?.compare ?? COMPARE_BUDGET_MS,
    extract: deps.budgetsMs?.extract ?? EXTRACT_BUDGET_MS,
    transcribe: deps.budgetsMs?.transcribe ?? TRANSCRIBE_BUDGET_MS,
  };
  const routes = new Hono();

  /** Registers a POST route that needs the API key: without one it answers 500 before reading the body. */
  const aiRoute = (path: string, handle: (request: AiRequest) => Promise<Response>) => {
    routes.post(path, async (c) => {
      // Read the disconnect signal first: the Node adapter only aborts it once it has been accessed.
      const clientSignal = c.req.raw.signal;
      const key = apiKey();
      if (!key) return c.json(errorResponse(MISSING_KEY, 500), 500);
      // Any body that isn't a JSON object reads as an empty one, which each handler answers with its own 400.
      const body = (await readJsonObject(c)) ?? {};
      return handle({ c, body, clientSignal, apiKey: key });
    });
  };

  // POST /api/analyze — analyze a word/phrase/sentence
  aiRoute('/analyze', async ({ c, body, clientSignal }) => {
    const { text, mode } = body;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return c.json(errorResponse('Missing "text" field', 400), 400);
    }
    if (text.trim().length > MAX_INPUT_CHARS) {
      return c.json(errorResponse(`Text is too long (maximum ${MAX_INPUT_CHARS} characters).`, 400), 400);
    }

    const route = routeQuery(text, mode);
    console.log(`Analyze request: ${text.length} chars, ${route.isWord ? 'word/phrase' : 'sentence'}${route.mode === 'batch' ? ', batch' : ''}${route.originalQuery ? ', Chinese' : ''}`);

    const ctx = createRequestContext(clientSignal, budgets.analyze);
    try {
      const { data, resolvedQuery } = await generateAnalysisData(chat, ctx, route);
      if (route.isWord) {
        return c.json({
          translation: '',
          grammar: '',
          visualKeyword: data.vocabs[0]?.word || resolvedQuery,
          pronunciation: data.vocabs[0]?.ipa || '',
          vocabs: data.vocabs,
          originalQuery: route.originalQuery,
          query: resolvedQuery,
        });
      }
      return c.json({ ...data, originalQuery: route.originalQuery, query: resolvedQuery });
    } catch (error) {
      return aiErrorResponse(c, error, ANALYSIS_ERRORS, clientSignal);
    }
  });

  // POST /api/extract-vocabulary — detect interesting words in text
  aiRoute('/extract-vocabulary', async ({ c, body, clientSignal }) => {
    const { text } = body;
    // Low floor (not 10): the main search routes short sentences (e.g. "Go away!", brief Chinese) here too.
    if (!text || typeof text !== 'string' || text.trim().length < 2) {
      return c.json(errorResponse('Please provide some text to analyze.', 400), 400);
    }

    const scanned = text.length > MAX_INPUT_CHARS ? text.substring(0, MAX_INPUT_CHARS) + '...' : text;
    const ctx = createRequestContext(clientSignal, budgets.extract);
    try {
      const scan = await chat(ctx, {
        ...vocabularyScanPrompts(scanned),
        maxTokens: EXTRACT_MAX_TOKENS,
        label: 'vocabulary scan',
        accept: acceptVocabularyScan,
      });
      // A 404 means only this: the text had nothing worth studying.
      if (scan.words.length === 0) {
        return c.json(errorResponse('No interesting vocabulary found in the text.', 404), 404);
      }
      // `translation` surfaces the translate-first step: when the input was Chinese, the model returns the English
      // it actually scanned. The client shows this (Text Analyzer) and uses it in the search status toast.
      return c.json({ words: scan.words, translation: scan.translation, sourceLang: scan.sourceLang });
    } catch (error) {
      return aiErrorResponse(c, error, EXTRACT_ERRORS, clientSignal);
    }
  });

  // POST /api/compare — compare 2 to MAX_COMPARE_WORDS words
  aiRoute('/compare', async ({ c, body, clientSignal }) => {
    const { words } = body;
    if (!Array.isArray(words)) {
      return c.json(errorResponse('Please provide at least 2 words to compare.', 400), 400);
    }
    const cleanWords = uniqueCompareWords(words);
    if (cleanWords.length < 2) {
      return c.json(errorResponse('Please provide at least 2 different words to compare.', 400), 400);
    }
    if (cleanWords.length > MAX_COMPARE_WORDS) {
      return c.json(errorResponse(`You can compare up to ${MAX_COMPARE_WORDS} words at a time.`, 400), 400);
    }

    const ctx = createRequestContext(clientSignal, budgets.compare);
    try {
      const comparison = await chat(ctx, {
        ...comparisonPrompts(cleanWords),
        maxTokens: COMPARE_MAX_TOKENS,
        label: 'comparison',
        accept: acceptComparison(cleanWords),
      });
      return c.json(comparison);
    } catch (error) {
      return aiErrorResponse(c, error, COMPARE_ERRORS, clientSignal);
    }
  });

  // POST /api/transcribe — speech-to-text with Whisper
  aiRoute('/transcribe', async ({ c, body, clientSignal, apiKey: key }) => {
    const { audio, mimeType = 'audio/webm' } = body;
    if (typeof audio !== 'string' || audio.length === 0 || audio.length > 24 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
      return c.json(errorResponse('Missing "audio" base64 data.', 400), 400);
    }
    if (typeof mimeType !== 'string' || !/^audio\/(?:mp4|mpeg|ogg|wav|webm)(?:;|$)/i.test(mimeType)) {
      return c.json(errorResponse('Unsupported audio type.', 415), 415);
    }
    // Recorders report codec parameters ("audio/webm;codecs=opus"); the upload name and type use the bare type.
    const baseType = mimeType.split(';')[0].trim().toLowerCase();
    const extension = baseType.split('/')[1] || 'webm';

    const ctx = createRequestContext(clientSignal, budgets.transcribe);
    try {
      const formData = new FormData();
      formData.append('audio', new Blob([Buffer.from(audio, 'base64')], { type: baseType }), `audio.${extension}`);
      const response = await doFetch(DEEPINFRA_WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
        signal: ctx.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) throw providerError(response.status, bodyText);
      let data: { text?: unknown } | null;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new AiError('invalid', 'Whisper returned a non-JSON response');
      }
      return c.json({ text: trimmedString(data?.text) });
    } catch (error) {
      return aiErrorResponse(c, error, TRANSCRIBE_ERRORS, clientSignal);
    }
  });

  return routes;
}

export const aiRoutes = createAiRoutes();
