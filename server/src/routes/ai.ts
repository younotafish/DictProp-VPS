import { Hono } from 'hono';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import {
  AiError,
  aiErrorResponse,
  createChatClient,
  createRequestContext,
  providerError,
  type AiErrorMessages,
  type FetchLike,
} from '../ai-client.js';
import { containsChinese, generateAnalysisData } from '../ai/analysis.js';
import { COMPARE_WORDS_INSTRUCTION, TEXT_DETECT_INSTRUCTION } from '../ai/prompts.js';
import { sanitizeComparison, sanitizeDetectedWords, trimmedString } from '../ai/sanitize.js';
import { isWordOrPhrase, MAX_COMPARE_WORDS } from '../shared/query-mode.js';

// The JSON extractor lives with the chat client; re-exported for existing callers and tests.
export { parseModelJson } from '../ai-client.js';

// ============================================================================
// Budgets and limits
// ============================================================================

// DeepSeek-V4-Flash can take well over a minute to emit a full multi-sense vocab card set ("run down"
// alone yields 6 full cards, ~74s clean and more under VPS load). Each request gets ONE overall budget,
// shared by the first answer, targeted card repairs and a re-ask, and it ends early if the client
// disconnects. The client waits this long plus 30s (services/api.ts).
const ANALYSIS_BUDGET_MS = 300_000;
// Comparisons run in the background queue and get a larger budget than searches.
const COMPARE_BUDGET_MS = 600_000;
const EXTRACT_BUDGET_MS = 240_000;
const TRANSCRIBE_BUDGET_MS = 30_000;

const COMPARE_MAX_TOKENS = 8_000;
const EXTRACT_MAX_TOKENS = 8_000;

const DEEPINFRA_WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo';

function errorResponse(msg: string, status: number) {
  return { error: msg, status };
}

// ============================================================================
// Routes
// ============================================================================

const ANALYSIS_ERRORS: AiErrorMessages = {
  label: 'Analysis',
  failed: 'Analysis failed. Please try again.',
  notFound: 'No dictionary entry found. Check the spelling and try again.',
};

export interface AiRouteDependencies {
  /** Outbound HTTP; proxyFetch unless a test injects a stub. */
  fetch?: FetchLike;
  apiKey?: () => string | undefined;
  retryDelayMs?: number;
  budgetsMs?: Partial<Record<'analyze' | 'compare' | 'extract' | 'transcribe', number>>;
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

  // POST /api/analyze — analyze a word/phrase/sentence
  routes.post('/analyze', async (c) => {
    // Read the disconnect signal first: the Node adapter only aborts it once it has been accessed.
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { text, mode } = await c.req.json().catch(() => ({}));
    if (typeof text !== 'string' || text.trim().length === 0) {
      return c.json(errorResponse('Missing "text" field', 400), 400);
    }
    if (text.trim().length > 5000) {
      return c.json(errorResponse('Text is too long (maximum 5000 characters).', 400), 400);
    }

    const isBatch = mode === 'batch';
    const originalQuery = containsChinese(text) ? text : undefined;
    // In batch mode, always treat input as a word/phrase (it's a pre-identified vocabulary item)
    const isWord = isBatch || isWordOrPhrase(text);
    console.log(`Analyze request: ${text.length} chars, ${isWord ? 'word/phrase' : 'sentence'}${isBatch ? ', batch' : ''}${originalQuery ? ', Chinese' : ''}`);

    const ctx = createRequestContext(clientSignal, budgets.analyze);
    try {
      const { rawData, resolvedQuery } = await generateAnalysisData(chat, ctx, text, isBatch ? 'batch' : undefined);
      if (isWord) {
        return c.json({
          translation: '',
          grammar: '',
          visualKeyword: rawData.vocabs?.[0]?.word || resolvedQuery,
          pronunciation: rawData.vocabs?.[0]?.ipa || '',
          vocabs: rawData.vocabs || [],
          originalQuery,
          query: resolvedQuery,
        });
      }
      return c.json({ ...rawData, originalQuery, query: resolvedQuery });
    } catch (error) {
      return aiErrorResponse(c, error, ANALYSIS_ERRORS, clientSignal);
    }
  });

  // POST /api/extract-vocabulary — detect interesting words in text
  routes.post('/extract-vocabulary', async (c) => {
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { text } = await c.req.json().catch(() => ({}));
    // Low floor (not 10): the main search routes short sentences (e.g. "Go away!", brief Chinese) here too.
    if (!text || typeof text !== 'string' || text.trim().length < 2) {
      return c.json(errorResponse('Please provide some text to analyze.', 400), 400);
    }

    const maxChars = 5000;
    const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
    const userPrompt = `Scan this text (given as a JSON string) and identify all rare, advanced, or interesting vocabulary worth studying:\n\n${JSON.stringify(truncatedText)}`;

    const ctx = createRequestContext(clientSignal, budgets.extract);
    try {
      const rawData = await chat(ctx, { system: TEXT_DETECT_INSTRUCTION, user: userPrompt, maxTokens: EXTRACT_MAX_TOKENS, label: 'vocabulary scan' });
      if (!Array.isArray(rawData.words) || rawData.words.length === 0) {
        return c.json(errorResponse('No interesting vocabulary found in the text.', 404), 404);
      }
      const words = sanitizeDetectedWords(rawData.words);
      if (words.length === 0) throw new AiError('invalid', 'Every detected word was malformed');
      return c.json({
        words,
        // Surface the translate-first step: when the input was Chinese, the model returns the English it
        // actually scanned. The client shows this (Text Analyzer) and uses it in the search status toast.
        translation: typeof rawData.translation === 'string' ? rawData.translation : '',
        sourceLang: rawData.sourceLang === 'zh' ? 'zh' : 'en',
      });
    } catch (error) {
      return aiErrorResponse(c, error, {
        label: 'Vocabulary detection',
        failed: 'Vocabulary detection failed. Please try again.',
        timeout: 'Timed out. Try a shorter text.',
      }, clientSignal);
    }
  });

  // POST /api/compare — compare 2 to MAX_COMPARE_WORDS words
  routes.post('/compare', async (c) => {
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { words } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(words)) {
      return c.json(errorResponse('Please provide at least 2 words to compare.', 400), 400);
    }
    const seen = new Set<string>();
    const cleanWords = words
      .map((w: unknown) => trimmedString(w))
      .filter((w: string) => {
        const key = w.toLowerCase();
        if (!w || w.length > 100 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (cleanWords.length < 2) {
      return c.json(errorResponse('Please provide at least 2 different words to compare.', 400), 400);
    }
    if (cleanWords.length > MAX_COMPARE_WORDS) {
      return c.json(errorResponse(`You can compare up to ${MAX_COMPARE_WORDS} words at a time.`, 400), 400);
    }

    const userPrompt = `Compare these words (given as a JSON array): ${JSON.stringify(cleanWords)}`;
    const ctx = createRequestContext(clientSignal, budgets.compare);
    try {
      const rawData = await chat(ctx, {
        system: COMPARE_WORDS_INSTRUCTION,
        user: userPrompt,
        maxTokens: COMPARE_MAX_TOKENS,
        timeoutMs: budgets.compare,
        label: 'comparison',
      });
      const comparison = sanitizeComparison(rawData, cleanWords);
      if (!comparison) throw new AiError('invalid', 'The comparison had no usable dimensions');
      return c.json(comparison);
    } catch (error) {
      return aiErrorResponse(c, error, {
        label: 'Comparison',
        failed: 'Comparison failed. Please try again.',
        timeout: 'Timed out. Please try again.',
      }, clientSignal);
    }
  });

  // POST /api/transcribe — speech-to-text with Whisper
  routes.post('/transcribe', async (c) => {
    const clientSignal = c.req.raw.signal;
    const key = apiKey();
    if (!key) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { audio, mimeType = 'audio/webm' } = await c.req.json().catch(() => ({}));
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
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new AiError('invalid', 'Whisper returned a non-JSON response');
      }
      return c.json({ text: trimmedString(data?.text) });
    } catch (error) {
      return aiErrorResponse(c, error, { label: 'Transcription', failed: 'Transcription failed. Please try again.' }, clientSignal);
    }
  });

  return routes;
}

export const aiRoutes = createAiRoutes();
