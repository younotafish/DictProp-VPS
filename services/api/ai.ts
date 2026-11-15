import type { ComparisonResult, SearchResult } from '../../types';
import { bytesToBase64 } from '../dataUri';
import { HttpError, jsonRequest, requestJson } from '../http';
import { log, logError } from '../logger';
import { MAX_COMPARE_WORDS } from '../queryMode';
import { sortVocabCardsByUsage } from '../usageAudit';
import { sanitizeComparisonResult } from './comparisons';
import { textOrEmpty } from './json';

// The AI routes: analysis, vocabulary scans, transcription and comparisons.

// Each AI route has an overall time budget on the server (server/src/routes/ai.ts: analysis 300 s,
// comparison 600 s, extraction 240 s, transcription 30 s). Wait 30 s longer, so the server's own 504
// with its message arrives before the client gives up.
const ANALYZE_TIMEOUT_MS = 330_000;
const COMPARE_TIMEOUT_MS = 630_000;
const EXTRACT_TIMEOUT_MS = 270_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

// A 429 carries a machine-readable token: QUOTA_EXCEEDED (billing — callers show a quota message) or
// RATE_LIMITED (transient). Every other failure stays an HttpError with the server's message.
const toAiError = (error: unknown): unknown => {
  if (!(error instanceof HttpError) || error.status !== 429) return error;
  if (error.responseBody.includes('QUOTA_EXCEEDED')) return new Error('QUOTA_EXCEEDED');
  return new HttpError('The AI provider rate-limited this request. Try again shortly.', 429, error.responseBody);
};

const postAi = async (path: string, body: unknown, label: string, timeoutMs: number): Promise<any> => {
  try {
    return await requestJson<any>(path, jsonRequest('POST', body), label, timeoutMs);
  } catch (error) {
    throw toAiError(error);
  }
};

export const analyzeInput = async (text: string, options?: { mode?: 'batch' }): Promise<SearchResult> => {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot analyze empty text");
  }

  try {
    const data = await postAi(
      '/api/analyze',
      { text, ...(options?.mode ? { mode: options.mode } : {}) },
      'Analysis',
      ANALYZE_TIMEOUT_MS,
    );

    const vocabs = sortVocabCardsByUsage((data.vocabs || [])
      .filter((v: any) => v && typeof v.word === 'string' && v.word.trim().length > 0)
      .map((v: any) => ({ ...v, id: crypto.randomUUID() })));

    return {
      id: crypto.randomUUID(),
      query: data.query || text,
      translation: data.translation,
      grammar: data.grammar,
      visualKeyword: data.visualKeyword,
      pronunciation: data.pronunciation,
      vocabs,
      timestamp: Date.now(),
      originalQuery: data.originalQuery,
    };
  } catch (error: any) {
    const msg = error.message || '';
    if (msg === 'QUOTA_EXCEEDED') throw error;
    if (error instanceof HttpError) throw error;

    logError('Analysis failed', error);
    // The server already waits a full window and retries transient upstream errors internally, so a
    // client-side retry would just double an already-long wait for a busy model. Surface it instead —
    // callers must show this so the search no longer fails silently.
    if (msg.includes('timed out') || msg.includes('504') || error.name === 'AbortError') {
      throw new Error('The model did not finish this search before the timeout. Please retry it.');
    }
    throw new Error(msg || 'Search failed. Please try again.');
  }
};

export interface DetectedWord {
  word: string;
  context: string;
  level: string;
  reason: string;
}

/** Result of a vocabulary scan: the detected expressions, plus the English the model actually scanned
 *  (populated when the input was Chinese, so callers can show/use the translate-first step). */
export interface VocabularyScan {
  words: DetectedWord[];
  translation: string;       // English translation of the whole input when Chinese; '' when already English
  sourceLang: 'zh' | 'en';
}

export const detectVocabulary = async (text: string): Promise<VocabularyScan> => {
  if (!text || text.trim().length < 2) {
    throw new Error('Please provide some text to analyze.');
  }

  let data: any;
  try {
    data = await postAi('/api/extract-vocabulary', { text }, 'Vocabulary detection', EXTRACT_TIMEOUT_MS);
  } catch (error: any) {
    if (error?.name === 'TimeoutError') {
      throw new Error('The model did not finish scanning this text before the timeout. Try a shorter text.');
    }
    throw error;
  }
  return {
    words: (Array.isArray(data.words) ? data.words : [])
      .filter((w: any) => w && typeof w.word === 'string' && w.word.trim())
      .map((w: any) => ({
        word: w.word.trim(),
        context: textOrEmpty(w.context),
        level: textOrEmpty(w.level) || 'C1',
        reason: textOrEmpty(w.reason),
      })),
    translation: typeof data.translation === 'string' ? data.translation : '',
    sourceLang: data.sourceLang === 'zh' ? 'zh' : 'en',
  };
};

export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  log('[transcribeAudio] Starting transcription...');

  const base64 = bytesToBase64(new Uint8Array(await audioBlob.arrayBuffer()));

  let data: any;
  try {
    data = await postAi(
      '/api/transcribe',
      { audio: base64, mimeType: audioBlob.type || 'audio/webm' },
      'Transcription',
      TRANSCRIBE_TIMEOUT_MS,
    );
  } catch (error: any) {
    if (error?.message === 'QUOTA_EXCEEDED') throw error;
    throw new Error('Transcription failed');
  }

  log('[transcribeAudio] Transcription successful:', data.text);
  return textOrEmpty(data.text);
};

export const compareWords = async (words: string[]): Promise<ComparisonResult> => {
  // Mirrors the server: trimmed, the same word (ignoring case) once, 2 to MAX_COMPARE_WORDS of them.
  const seen = new Set<string>();
  const uniqueWords: string[] = [];
  for (const word of words || []) {
    const trimmed = typeof word === 'string' ? word.trim() : '';
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    uniqueWords.push(trimmed);
  }
  if (uniqueWords.length < 2) {
    throw new Error('Please provide at least 2 different words to compare.');
  }
  if (uniqueWords.length > MAX_COMPARE_WORDS) {
    throw new Error(`You can compare up to ${MAX_COMPARE_WORDS} words at a time.`);
  }

  try {
    const data = await postAi('/api/compare', { words: uniqueWords }, 'Comparison', COMPARE_TIMEOUT_MS);
    return sanitizeComparisonResult(data, uniqueWords);
  } catch (error: any) {
    const msg = error.message || '';
    if (msg === 'QUOTA_EXCEEDED') throw error;
    if (error instanceof HttpError) throw error;

    logError('Word comparison failed', error);
    // See analyzeInput: the server owns the timeout + transient-retry, so don't double the wait here.
    if (msg.includes('timed out') || msg.includes('504') || error.name === 'AbortError') {
      throw new Error('The model did not finish this comparison before the timeout. Please retry it.');
    }
    throw new Error(msg || 'Word comparison failed. Please try again.');
  }
};
