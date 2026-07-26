import { env } from './env.js';
import { proxyFetch } from './proxy-fetch.js';
import {
  hasSentenceGrammarAnalysis,
  isSentenceGrammarAnalysis,
  isSentenceAnalysis,
  SENTENCE_GRAMMAR_INSTRUCTION,
  SENTENCE_ANALYSIS_INSTRUCTION,
  sentenceGrammarUserPrompt,
  sentenceAnalysisUserPrompt,
  type SentenceGrammarAnalysis,
  type SentenceAnalysis,
} from './sentence-analysis.js';

const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const TIMEOUT_MS = 300_000;

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

async function generateJson(
  systemInstruction: string,
  userPrompt: string,
  errorLabel: string,
  isValid: (value: unknown) => boolean,
): Promise<unknown> {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) throw new Error('DEEPINFRA_API_KEY is not configured');

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const correction = attempt === 0
        ? ''
        : '\nYour previous response failed schema validation. Return every required field as one valid JSON object.';
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
      if (!isValid(parsed)) throw new Error(`${errorLabel} failed schema validation`);
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

export async function generateSentenceAnalysis(text: string): Promise<SentenceAnalysis> {
  if (!text.trim()) throw new Error('Sentence text is empty');
  const analysis = await generateJson(
    SENTENCE_ANALYSIS_INSTRUCTION,
    sentenceAnalysisUserPrompt(text),
    'Sentence analysis',
    value => isSentenceAnalysis(value) && hasSentenceGrammarAnalysis(value),
  );
  return analysis as SentenceAnalysis;
}

export async function generateSentenceGrammarAnalysis(
  text: string,
  translation?: string,
): Promise<SentenceGrammarAnalysis> {
  if (!text.trim()) throw new Error('Sentence text is empty');
  const result = await generateJson(
    SENTENCE_GRAMMAR_INSTRUCTION,
    sentenceGrammarUserPrompt(text, translation),
    'Sentence grammar analysis',
    value => isSentenceGrammarAnalysis((value as any)?.grammar),
  );
  return (result as any).grammar;
}
