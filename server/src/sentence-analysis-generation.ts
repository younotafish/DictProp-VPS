import { env } from './env.js';
import { proxyFetch } from './proxy-fetch.js';
import {
  extractSentenceAnalysis,
  extractSentenceGrammarAnalysis,
  hasCompleteSentenceAnalysis,
  hasSentenceGrammarAnalysis,
  SENTENCE_GRAMMAR_INSTRUCTION,
  SENTENCE_ANALYSIS_INSTRUCTION,
  sentenceGrammarUserPrompt,
  sentenceAnalysisUserPrompt,
  sentenceAnalysisValidationIssues,
  withLegacyNaturalSpeechIpa,
  type SentenceGrammarAnalysis,
  type SentenceAnalysis,
} from './sentence-analysis.js';

const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const TIMEOUT_MS = 300_000;

function grammarMatchesText(grammar: SentenceGrammarAnalysis | undefined, text: string): grammar is SentenceGrammarAnalysis {
  if (!grammar) return false;
  const plainText = text
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1');
  return grammar.points.every(point => plainText.includes(point.excerpt));
}

function parseJson(content: unknown): unknown {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Sentence analysis was empty');
  let value = content.trim();
  const fence = value.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence) value = fence[1].trim();
  try {
    return JSON.parse(value);
  } catch {
    const object = value.match(/\{[\s\S]*\}/);
    if (!object) throw new Error('Sentence analysis was not JSON');
    return JSON.parse(object[0]);
  }
}

function describeJsonShape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth >= 2 ? `array(${value.length})` : `array(${value.length})<${describeJsonShape(value[0], depth + 1)}>`;
  }
  if (typeof value !== 'object') return typeof value;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
  if (depth >= 2) return `object{${entries.map(([key]) => key).join(',')}}`;
  return `object{${entries.map(([key, child]) => `${key}:${describeJsonShape(child, depth + 1)}`).join(',')}}`;
}

async function generateJson(
  systemInstruction: string,
  userPrompt: string,
  errorLabel: string,
  isValid: (value: unknown) => boolean,
  validationIssues?: (value: unknown) => string[],
): Promise<unknown> {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) throw new Error('DEEPINFRA_API_KEY is not configured');

  let lastError: unknown;
  let retryDetail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const correction = attempt === 0
        ? ''
        : `\nYour previous response failed schema validation. Fix these exact problems: ${retryDetail || 'return every required field as one valid JSON object'}.`;
      const response = await proxyFetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: `${systemInstruction}${correction}` },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.35,
        }),
        signal: controller.signal,
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Sentence analysis provider returned ${response.status}`);
      const parsed = parseJson(payload?.choices?.[0]?.message?.content);
      if (!isValid(parsed)) {
        retryDetail = validationIssues?.(parsed).slice(0, 8).join('; ') || '';
        const detail = retryDetail ? `: ${retryDetail}` : '';
        throw new Error(`${errorLabel} failed schema validation (${describeJsonShape(parsed)})${detail}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2_000 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${errorLabel} failed`);
}

export async function generateSentenceAnalysis(
  text: string,
  preservedGrammar?: SentenceGrammarAnalysis,
): Promise<SentenceAnalysis> {
  if (!text.trim()) throw new Error('Sentence text is empty');
  const analysis = await generateJson(
    SENTENCE_ANALYSIS_INSTRUCTION,
    sentenceAnalysisUserPrompt(text),
    'Sentence analysis',
    value => extractSentenceAnalysis(value) !== null,
    sentenceAnalysisValidationIssues,
  );
  const extracted = extractSentenceAnalysis(analysis);
  if (!extracted) throw new Error('Sentence analysis failed schema validation');
  const complete = grammarMatchesText(preservedGrammar, text)
    ? { ...extracted, grammar: preservedGrammar }
    : extracted;
  if (!hasCompleteSentenceAnalysis(complete)) throw new Error('Sentence analysis failed completeness validation');
  return withLegacyNaturalSpeechIpa(complete);
}

export async function generateSentenceGrammarAnalysis(
  text: string,
  translation?: string,
): Promise<SentenceGrammarAnalysis> {
  if (!text.trim()) throw new Error('Sentence text is empty');
  try {
    const result = await generateJson(
      SENTENCE_GRAMMAR_INSTRUCTION,
      sentenceGrammarUserPrompt(text, translation),
      'Sentence grammar analysis',
      value => extractSentenceGrammarAnalysis(value) !== null,
    );
    const grammar = extractSentenceGrammarAnalysis(result);
    if (!grammar) throw new Error('Sentence grammar analysis failed schema validation');
    return grammar;
  } catch (error) {
    const focusedError = error instanceof Error ? error : new Error(String(error));
    if (!focusedError.message.includes('schema validation')) throw focusedError;
    try {
      const replacement = await generateSentenceAnalysis(text);
      if (hasSentenceGrammarAnalysis(replacement)) return replacement.grammar;
    } catch (fallbackError) {
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${focusedError.message}; full-analysis fallback failed: ${detail}`);
    }
    throw focusedError;
  }
}
