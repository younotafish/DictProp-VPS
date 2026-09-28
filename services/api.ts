import { StoredItem, SearchResult, ComparisonResult, StoredComparison, ReviewEvent, ReviewHistory, RevisionCursor } from '../types';
import { dataUriToBlob } from './dataUri';
import { log, error as logError } from './logger';
import { HttpError, jsonRequest, requestJson, requestVoid, responseToHttpError } from './http';
import { publishServerMutation } from './syncSignals';
import { sortVocabCardsByUsage } from './usageAudit';
import type { RawEssayCatalog } from './essayCatalog';

// Same origin — Hono serves both API and static files
const API_BASE = '';

export const loadPrivateEssayCatalog = async (): Promise<RawEssayCatalog> =>
  requestJson<RawEssayCatalog>(`${API_BASE}/api/essays/catalog`, undefined, 'Load private essay catalog');

// Internal ID generator
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// ============================================================================
// Items API (replaces firebase.ts data functions)
// ============================================================================

export type { RevisionCursor };

/** The whole library, plus the cursor after its last change, where the next delta pull starts. */
export const loadAllItems = async (): Promise<{ items: StoredItem[]; cursor: RevisionCursor }> => {
  const items: StoredItem[] = [];
  let cursor: RevisionCursor = { revision: 0, id: '' };
  for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
    const page = await loadItemChanges(cursor);
    items.push(...page.items);
    if (!page.hasMore) return { items, cursor: page.cursor };
    if (page.cursor.revision === cursor.revision && page.cursor.id === cursor.id) {
      throw new Error('Load items cursor did not advance');
    }
    cursor = page.cursor;
  }
  throw new Error('Load items exceeded its page limit');
};

export interface ItemChanges {
  items: StoredItem[];
  cursor: RevisionCursor;
  hasMore: boolean;
  /** Newest revision the server has issued; older servers omit it. */
  headRevision?: number;
}

export const loadItemChanges = async (cursor: RevisionCursor, limit = 500): Promise<ItemChanges> => {
  const params = new URLSearchParams({
    afterRevision: String(cursor.revision),
    afterId: cursor.id,
    limit: String(limit),
  });
  return requestJson<ItemChanges>(`${API_BASE}/api/items?${params}`, undefined, 'Load item changes');
};

/** What the server kept for a push: new revisions, plus its own copy wherever it kept different content. */
export interface SaveItemsResult {
  revisions: Map<string, number>;
  canonical: Map<string, StoredItem>;
}

export const saveItems = async (items: readonly StoredItem[]): Promise<SaveItemsResult> => {
  const saved: SaveItemsResult = { revisions: new Map(), canonical: new Map() };
  const batchSize = 200;
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const result = await requestJson<{
      revisions?: Record<string, number>;
      conflicts?: string[];
      canonical?: StoredItem[];
    }>(
      `${API_BASE}/api/items`, jsonRequest('PUT', batch), 'Save items',
    );
    for (const [id, revision] of Object.entries(result.revisions ?? {})) {
      if (typeof revision === 'number') saved.revisions.set(id, revision);
    }
    for (const item of result.canonical ?? []) saved.canonical.set(item.data.id, item);
  }
  publishServerMutation();
  return saved;
};

export const loadReviewHistory = async (recentSince: number): Promise<ReviewHistory> =>
  requestJson(`${API_BASE}/api/reviews/history?recentSince=${recentSince}`, undefined, 'Load review history');

export const saveReviewEvent = async (event: ReviewEvent): Promise<void> =>
  requestVoid(`${API_BASE}/api/reviews`, jsonRequest('POST', event), 'Save review event');

export interface AppliedReviewResponse {
  applied: boolean;
  event: ReviewEvent;
  items: StoredItem[];
}

export const applyReviewMutation = async (
  event: ReviewEvent,
  itemIds: string[],
  seedItem?: StoredItem,
): Promise<AppliedReviewResponse> => {
  const result = await requestJson<AppliedReviewResponse>(
    `${API_BASE}/api/reviews/apply`,
    jsonRequest('POST', { event, itemIds, ...(seedItem ? { seedItem } : {}) }),
    'Apply review',
  );
  publishServerMutation();
  return result;
};

export interface UndoReviewResponse {
  undone: boolean;
  eventId: string;
  items: StoredItem[];
}

export const undoReviewMutation = async (eventId: string): Promise<UndoReviewResponse> => {
  const result = await requestJson<UndoReviewResponse>(
    `${API_BASE}/api/reviews/${encodeURIComponent(eventId)}/undo`,
    { method: 'POST' },
    'Undo review',
  );
  publishServerMutation();
  return result;
};

/**
 * Fetch a single item's image file via the binary image endpoint.
 * - 404 → null: the item genuinely has no image (callers should NOT retry).
 * - network error / 5xx → throws: a transient failure (callers MAY retry).
 * This distinction lets OfflineImage retry flaky downloads instead of giving up on the first miss.
 */
export const loadItemImage = async (itemId: string, imageVersion?: string): Promise<Blob | null> => {
  const versionQuery = imageVersion ? `?v=${encodeURIComponent(imageVersion)}` : '';
  const res = await fetch(`${API_BASE}/api/items/${encodeURIComponent(itemId)}/image${versionQuery}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
  return res.blob();
};

/** Fetch the image files of several items, four at a time. Items without one are omitted. */
export const loadItemImagesBatch = async (
  ids: string[],
  imageVersions?: ReadonlyMap<string, string>,
): Promise<Map<string, Blob>> => {
  const result = new Map<string, Blob>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const image = await loadItemImage(id, imageVersions?.get(id));
        if (image) result.set(id, image);
      } catch { /* a later prefetch can retry transient failures */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return result;
};

/**
 * Fetch the set of image ids the server currently has stored (item + vocab ids).
 * Used by the recovery action to compute which local images are missing on the server.
 */
export const getServerImageManifest = async (): Promise<Set<string>> => {
  const ids = await requestJson<unknown>(
    `${API_BASE}/api/items/images/manifest`,
    undefined,
    'Load image manifest',
  );
  return new Set(Array.isArray(ids) ? ids : []);
};

/**
 * Upload images (files or data URIs) to the server (upload-on-create and recovery).
 * Callers should chunk to <=10 entries per call to keep payloads small.
 */
export const uploadImages = async (
  images: Record<string, Blob | string>
): Promise<{ ok: boolean; saved: number }> => {
  let saved = 0;
  for (const [id, image] of Object.entries(images)) {
    const blob = typeof image === 'string' ? dataUriToBlob(image) : image;
    const response = await fetch(`${API_BASE}/api/items/${encodeURIComponent(id)}/image`, {
      method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob,
    });
    if (!response.ok) throw new Error(`Upload image failed (${response.status})`);
    saved++;
  }
  // Each upload bumps the revision of the items showing the image, so other tabs pull the new marker.
  if (saved > 0) publishServerMutation();
  return { ok: true, saved };
};

// ============================================================================
// JSON Import API
// ============================================================================

export const importJSON = async (
  items: any[],
): Promise<{ ok: boolean; imported: number; skipped: number; imagesFetched: number }> => {
  const res = await fetch(`${API_BASE}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `Import failed: ${res.status}`);
  }
  return res.json();
};

// ============================================================================
// AI API (replaces aiService.ts)
// ============================================================================

export const analyzeInput = async (text: string, options?: { mode?: 'batch' }): Promise<SearchResult> => {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot analyze empty text");
  }

  const attemptCall = async (): Promise<SearchResult> => {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(options?.mode ? { mode: options.mode } : {}) }),
    });

    if (!res.ok) {
      const error = await responseToHttpError(res, 'Analysis');
      if (error.status === 429) throw new Error('QUOTA_EXCEEDED');
      throw error;
    }

    const data = await res.json();

    const vocabs = sortVocabCardsByUsage((data.vocabs || [])
      .filter((v: any) => v && typeof v.word === 'string' && v.word.trim().length > 0)
      .map((v: any) => ({ ...v, id: generateId() })));

    return {
      id: generateId(),
      query: data.query || text,
      translation: data.translation,
      grammar: data.grammar,
      visualKeyword: data.visualKeyword,
      pronunciation: data.pronunciation,
      vocabs,
      timestamp: Date.now(),
      originalQuery: data.originalQuery,
    };
  };

  try {
    return await attemptCall();
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

  const res = await fetch(`${API_BASE}/api/extract-vocabulary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const error = await responseToHttpError(res, 'Vocabulary detection');
    if (error.status === 429) throw new Error('QUOTA_EXCEEDED');
    throw error;
  }

  const data = await res.json();
  return {
    words: (data.words || []).map((w: any) => ({
      word: w.word.trim(),
      context: w.context || '',
      level: w.level || 'C1',
      reason: w.reason || '',
    })),
    translation: typeof data.translation === 'string' ? data.translation : '',
    sourceLang: data.sourceLang === 'zh' ? 'zh' : 'en',
  };
};

export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  log('[transcribeAudio] Starting transcription...');

  const arrayBuffer = await audioBlob.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
  );

  const res = await fetch(`${API_BASE}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: base64, mimeType: audioBlob.type || 'audio/webm' }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
    throw new Error('Transcription failed');
  }

  const data = await res.json();
  log('[transcribeAudio] Transcription successful:', data.text);
  return data.text || '';
};

export const compareWords = async (words: string[]): Promise<ComparisonResult> => {
  if (!words || words.length < 2) {
    throw new Error('Please provide at least 2 words to compare.');
  }

  const attemptCall = async (): Promise<ComparisonResult> => {
    const res = await fetch(`${API_BASE}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words }),
    });

    if (!res.ok) {
      const error = await responseToHttpError(res, 'Comparison');
      if (error.status === 429) throw new Error('QUOTA_EXCEEDED');
      throw error;
    }

    const data = await res.json();
    return {
      words: data.words || words,
      summary: data.summary || '',
      dimensions: Array.isArray(data.dimensions) ? data.dimensions : [],
      examples: Array.isArray(data.examples) ? data.examples : [],
      commonMistakes: Array.isArray(data.commonMistakes) ? data.commonMistakes : [],
      verdict: data.verdict || '',
    };
  };

  try {
    return await attemptCall();
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

// ============================================================================
// Comparisons API (persisted side-by-side analyses, keyed by the word-set)
// ============================================================================

export const loadComparisons = async (): Promise<StoredComparison[]> => {
  return requestJson<StoredComparison[]>(
    `${API_BASE}/api/comparisons`,
    undefined,
    'Load comparisons',
  );
};

export const saveComparisonApi = async (comparison: StoredComparison): Promise<void> => {
  return requestVoid(
    `${API_BASE}/api/comparisons`,
    jsonRequest('PUT', comparison),
    'Save comparison',
  );
};

// ============================================================================
// TTS cache (server-side MiMo audio, fetched as cached clips)
// ============================================================================

// MiMo remains the production default while the offline replacement undergoes a blinded
// connected-speech benchmark. Imported Qwen clips retain their immutable cache keys on the server,
// but the client must not prefer them until a perceptual recipe is approved.
export const TTS_VOICE = 'Mia';
export const TTS_CASUAL_VOICE = 'casual';
export const TTS_LEGACY_VOICE = 'Mia';
export const TTS_LEGACY_CASUAL_VOICE = 'casual';

/** One word's playback timing within a cached clip (from the server's whisper word-alignment pass). */
export interface WordTiming { start: number; end: number; text: string }

/**
 * Cache key for a clip — sha256(voice + "\n" + text.trim()), hex.
 * MUST match the server's ttsKey (server/src/routes/tts.ts).
 */
export const ttsKey = async (text: string, voice: string): Promise<string> => {
  const data = new TextEncoder().encode(`${voice}\n${text.trim()}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// A plain fetch() has NO timeout: a stalled connection (a wedged mobile keep-alive socket, or the
// 1-vCPU VPS briefly busy) leaves the await hanging for the browser's multi-minute default — the
// "audio takes forever to load even on good 5G" symptom. Bound every TTS fetch so a stall aborts and
// the caller can fall back (system/Kokoro voice) instead of hanging. The timeout spans headers AND the
// body read (we clear it only after .blob()/.json() resolves), so a mid-body stall is caught too.
const TTS_AUDIO_TIMEOUT_MS = 8000;    // audio is what we play — be patient, but never infinite
const TTS_TIMINGS_TIMEOUT_MS = 6000;  // timings are non-essential (lead-in trim / seek) — bg-warmed

/** Fetch a cached clip by key. Returns the audio Blob, or null on miss (404) / timeout / error. */
export const fetchCachedTTS = async (key: string, timeoutMs = TTS_AUDIO_TIMEOUT_MS): Promise<Blob | null> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/tts/${key}.mp3`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

/** Fetch a clip's per-word timings by key. Returns the WordTiming[] or null on miss / timeout / error. */
export const fetchCachedTTSTimings = async (key: string, timeoutMs = TTS_TIMINGS_TIMEOUT_MS): Promise<WordTiming[] | null> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/tts/${key}/timings`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

/** Ask the server to generate + cache clips (used by the live cache-miss trigger and the bulk sweep). */
export const requestTTSGeneration = async (
  items: Array<{ text: string; voice?: string }>
): Promise<{ generated: number; skipped: number; failed: number }> => {
  return requestJson(
    `${API_BASE}/api/tts/generate`,
    jsonRequest('POST', { items }),
    'Generate TTS',
  );
};

export interface TtsBackfillStatus { running: boolean; total: number; done: number; generated: number; failed: number }

/** Start the server-side background backfill (audio + word timings for every sentence). Idempotent. */
export const startTtsBackfill = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    `${API_BASE}/api/tts/backfill`,
    { method: 'POST' },
    'Start TTS backfill',
  );
};

/** Poll the server-side backfill progress. */
export const getTtsBackfillStatus = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    `${API_BASE}/api/tts/backfill`,
    undefined,
    'Load TTS backfill status',
  );
};

/** Of the given keys, which are already cached on the server (so the bulk sweep can skip them). */
export const ttsManifest = async (keys: string[]): Promise<Set<string>> => {
  if (keys.length === 0) return new Set();
  try {
    const res = await fetch(`${API_BASE}/api/tts/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(Array.isArray(data.have) ? data.have : []);
  } catch {
    return new Set();
  }
};
