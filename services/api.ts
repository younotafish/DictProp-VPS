import { StoredItem, SearchResult, ComparisonResult, StoredComparison, ReviewEvent, ReviewHistory, RevisionCursor } from '../types';
import { bytesToBase64, dataUriToBlob } from './dataUri';
import { log, logError } from './logger';
import { fetchWithin, HttpError, jsonRequest, requestJson, requestVoid } from './http';
import { MAX_COMPARE_WORDS } from './queryMode';
import { publishServerMutation } from './syncSignals';
import { sortVocabCardsByUsage } from './usageAudit';
import type { RawEssayCatalog } from './essayCatalog';

export const loadPrivateEssayCatalog = async (): Promise<RawEssayCatalog> =>
  requestJson<RawEssayCatalog>('/api/essays/catalog', undefined, 'Load private essay catalog');

// ============================================================================
// Items API
// ============================================================================

export interface ItemChanges {
  items: StoredItem[];
  cursor: RevisionCursor;
  hasMore: boolean;
  /** Newest revision the server has issued; older servers omit it. */
  headRevision?: number;
}

// The most changes the server sends in one page (server/src/db.ts getItemsAfterRevision caps the limit at 500).
const ITEM_PAGE_SIZE = 500;
const MAX_ITEM_PAGES = 100_000;

export const loadItemChanges = async (cursor: RevisionCursor, limit = ITEM_PAGE_SIZE): Promise<ItemChanges> => {
  const params = new URLSearchParams({
    afterRevision: String(cursor.revision),
    afterId: cursor.id,
    limit: String(limit),
  });
  return requestJson<ItemChanges>(`/api/items?${params}`, undefined, 'Load item changes');
};

const isAfter = (a: RevisionCursor, b: RevisionCursor): boolean =>
  a.revision > b.revision || (a.revision === b.revision && a.id > b.id);

export interface ItemChangesSince {
  items: StoredItem[];
  /** After the last change, where the next pull starts. */
  cursor: RevisionCursor;
  /**
   * The server's newest revision is older than the starting cursor: its database was replaced, so only a full
   * snapshot can reconcile. No items come back then, and the cursor is the starting one.
   */
  serverBehind: boolean;
}

/** Every change after `from`, page after page. Throws when a page that promises more doesn't move the cursor on. */
export const loadItemChangesSince = async (from: RevisionCursor): Promise<ItemChangesSince> => {
  const items: StoredItem[] = [];
  let cursor = from;
  for (let pageNumber = 0; pageNumber < MAX_ITEM_PAGES; pageNumber++) {
    const page = await loadItemChanges(cursor);
    if (page.headRevision !== undefined && page.headRevision < from.revision) {
      return { items: [], cursor: from, serverBehind: true };
    }
    items.push(...page.items);
    if (!page.hasMore) return { items, cursor: page.cursor, serverBehind: false };
    if (!isAfter(page.cursor, cursor)) throw new Error('Load items cursor did not advance');
    cursor = page.cursor;
  }
  throw new Error('Load items exceeded its page limit');
};

/** The whole library, plus the cursor after its last change, where the next delta pull starts. */
export const loadAllItems = async (): Promise<{ items: StoredItem[]; cursor: RevisionCursor }> => {
  const { items, cursor } = await loadItemChangesSince({ revision: 0, id: '' });
  return { items, cursor };
};

/** What the server kept for a push: new revisions, plus its own copy wherever it kept different content. */
export interface SaveItemsResult {
  revisions: Map<string, number>;
  canonical: Map<string, StoredItem>;
  /** Items the server refuses (invalid, or too large to send), with its reason. The others still save. */
  rejected: Map<string, string>;
  /** Why the push stopped early. The batches before it saved; it and the rest didn't. */
  error?: unknown;
}

const SAVE_BATCH_SIZE = 200;

export const saveItems = async (items: readonly StoredItem[]): Promise<SaveItemsResult> => {
  const saved: SaveItemsResult = { revisions: new Map(), canonical: new Map(), rejected: new Map() };
  const send = async (batch: readonly StoredItem[]): Promise<void> => {
    let result: { revisions?: Record<string, number>; canonical?: StoredItem[] };
    try {
      result = await requestJson('/api/items', jsonRequest('PUT', batch), 'Save items');
    } catch (error) {
      // The server refuses a whole batch for one bad item, so a refused batch is split until each bad
      // item is alone: otherwise it would hold back every save after it.
      if (!(error instanceof HttpError) || (error.status !== 400 && error.status !== 413)) throw error;
      if (batch.length === 1) {
        saved.rejected.set(batch[0].data.id, error.responseBody || error.message);
        return;
      }
      const half = Math.ceil(batch.length / 2);
      await send(batch.slice(0, half));
      await send(batch.slice(half));
      return;
    }
    for (const [id, revision] of Object.entries(result.revisions ?? {})) {
      if (typeof revision === 'number') saved.revisions.set(id, revision);
    }
    for (const item of result.canonical ?? []) saved.canonical.set(item.data.id, item);
  };
  try {
    for (let start = 0; start < items.length; start += SAVE_BATCH_SIZE) {
      await send(items.slice(start, start + SAVE_BATCH_SIZE));
    }
  } catch (error) {
    // What earlier batches saved still has to be recorded, or those items would be sent again.
    if (saved.revisions.size === 0 && saved.canonical.size === 0) throw error;
    saved.error = error;
  }
  if (saved.revisions.size > 0 || saved.canonical.size > 0) publishServerMutation();
  return saved;
};

export const loadReviewHistory = async (recentSince: number): Promise<ReviewHistory> =>
  requestJson(`/api/reviews/history?recentSince=${recentSince}`, undefined, 'Load review history');

export const saveReviewEvent = async (event: ReviewEvent): Promise<void> =>
  requestVoid('/api/reviews', jsonRequest('POST', event), 'Save review event');

export interface AppliedReviewResponse {
  applied: boolean;
  event: ReviewEvent;
  items: StoredItem[];
  /** Each item's revision just before the review; older servers and some replays omit it. */
  baseRevisions?: Record<string, number>;
}

export const applyReviewMutation = async (
  event: ReviewEvent,
  itemIds: string[],
  seedItem?: StoredItem,
): Promise<AppliedReviewResponse> => {
  const result = await requestJson<AppliedReviewResponse>(
    '/api/reviews/apply',
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
  /** Each item's revision just before the undo; older servers omit it. */
  baseRevisions?: Record<string, number>;
}

export const undoReviewMutation = async (eventId: string): Promise<UndoReviewResponse> => {
  const result = await requestJson<UndoReviewResponse>(
    `/api/reviews/${encodeURIComponent(eventId)}/undo`,
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
  const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/image${versionQuery}`);
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
    '/api/items/images/manifest',
    undefined,
    'Load image manifest',
  );
  return new Set(Array.isArray(ids) ? ids : []);
};

/**
 * Uploads pictures (files or data URIs) to the server, one request each, in order: a new picture's upload and the
 * recovery action. Throws at the first that fails; the ones before it are stored.
 */
export const uploadImages = async (images: Record<string, Blob | string>): Promise<void> => {
  let saved = 0;
  for (const [id, image] of Object.entries(images)) {
    const blob = typeof image === 'string' ? dataUriToBlob(image) : image;
    const response = await fetch(`/api/items/${encodeURIComponent(id)}/image`, {
      method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob,
    });
    if (!response.ok) throw new Error(`Upload image failed (${response.status})`);
    saved++;
  }
  // Each upload bumps the revision of the items showing the image, so other tabs pull the new marker.
  if (saved > 0) publishServerMutation();
};

// ============================================================================
// JSON Import API
// ============================================================================

export const importJSON = async (
  items: any[],
): Promise<{ ok: boolean; imported: number; skipped: number; imagesFetched: number }> => {
  const res = await fetch('/api/import', {
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
// AI API
// ============================================================================

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

const textOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

// Only string values survive: the comparison view renders these maps directly.
const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
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

// Keeps only the well-formed parts of a comparison. The comparison view renders these fields directly,
// and a saved comparison opens on every device, so one non-string value must not reach it.
const sanitizeComparisonResult = (data: any, fallbackWords: string[]): ComparisonResult => {
  const resultWords = Array.isArray(data?.words) && data.words.length > 0 &&
    data.words.every((word: unknown) => typeof word === 'string' && word.trim())
    ? data.words as string[]
    : fallbackWords;
  return {
    words: resultWords,
    summary: textOrEmpty(data?.summary),
    dimensions: (Array.isArray(data?.dimensions) ? data.dimensions : [])
      .filter((dimension: any) => dimension && typeof dimension.label === 'string' && dimension.label)
      .map((dimension: any) => ({
        label: dimension.label,
        analysis: textOrEmpty(dimension.analysis),
        perWord: stringRecord(dimension.perWord),
      })),
    examples: (Array.isArray(data?.examples) ? data.examples : [])
      .filter((example: any) => example && typeof example === 'object')
      .map((example: any) => ({ context: textOrEmpty(example.context), sentences: stringRecord(example.sentences) }))
      .filter((example: { sentences: Record<string, string> }) => Object.keys(example.sentences).length > 0),
    commonMistakes: (Array.isArray(data?.commonMistakes) ? data.commonMistakes : [])
      .filter((mistake: unknown): mistake is string => typeof mistake === 'string' && mistake.trim().length > 0),
    verdict: textOrEmpty(data?.verdict),
  };
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

// ============================================================================
// Comparisons API (persisted side-by-side analyses, keyed by the word-set)
// ============================================================================

export const loadComparisons = async (): Promise<StoredComparison[]> => {
  const stored = await requestJson<unknown>(
    '/api/comparisons',
    undefined,
    'Load comparisons',
  );
  // Comparisons saved before /api/compare validated its output can hold non-string values; clean them
  // for display (nothing here is written back).
  return (Array.isArray(stored) ? stored : [])
    .filter((entry: any) => entry && typeof entry === 'object')
    .map((entry: any) => {
      const words = (Array.isArray(entry.words) ? entry.words : [])
        .filter((word: unknown): word is string => typeof word === 'string');
      return { ...entry, words, data: sanitizeComparisonResult(entry.data, words) };
    });
};

export const saveComparisonApi = async (comparison: StoredComparison): Promise<void> => {
  return requestVoid(
    '/api/comparisons',
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
// body read (fetchWithin), so a mid-body stall is caught too.
const TTS_AUDIO_TIMEOUT_MS = 8000;    // audio is what we play — be patient, but never infinite
const TTS_TIMINGS_TIMEOUT_MS = 6000;  // timings are non-essential (lead-in trim / seek) — bg-warmed

/** Fetch a cached clip by key. Returns the audio Blob, or null on miss (404) / timeout / error. */
export const fetchCachedTTS = async (key: string, timeoutMs = TTS_AUDIO_TIMEOUT_MS): Promise<Blob | null> => {
  try {
    return await fetchWithin(`/api/tts/${key}.mp3`, undefined, timeoutMs, async (res) => (res.ok ? await res.blob() : null));
  } catch {
    return null;
  }
};

/** Fetch a clip's per-word timings by key. Returns the WordTiming[] or null on miss / timeout / error. */
export const fetchCachedTTSTimings = async (key: string, timeoutMs = TTS_TIMINGS_TIMEOUT_MS): Promise<WordTiming[] | null> => {
  try {
    return await fetchWithin(`/api/tts/${key}/timings`, undefined, timeoutMs, async (res) => {
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    });
  } catch {
    return null;
  }
};

// The server takes at most 40 clips per request and answers once their audio is stored (three at a
// time, a few seconds each), so a full request needs well over the default 30 s.
const TTS_GENERATE_CHUNK = 40;
const TTS_GENERATE_TIMEOUT_MS = 180_000;

/** Ask the server to generate + cache clips (used by the live cache-miss trigger and the bulk sweep). */
export const requestTTSGeneration = async (
  items: Array<{ text: string; voice?: string }>
): Promise<{ generated: number; skipped: number; failed: number }> => {
  const total = { generated: 0, skipped: 0, failed: 0 };
  for (let start = 0; start < items.length; start += TTS_GENERATE_CHUNK) {
    const result = await requestJson<{ generated?: number; skipped?: number; failed?: number }>(
      '/api/tts/generate',
      jsonRequest('POST', { items: items.slice(start, start + TTS_GENERATE_CHUNK) }),
      'Generate TTS',
      TTS_GENERATE_TIMEOUT_MS,
    );
    total.generated += Number(result.generated) || 0;
    total.skipped += Number(result.skipped) || 0;
    total.failed += Number(result.failed) || 0;
  }
  return total;
};

export interface TtsBackfillStatus { running: boolean; total: number; done: number; generated: number; failed: number }

/** Start the server-side background backfill (audio + word timings for every sentence). Idempotent. */
export const startTtsBackfill = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    '/api/tts/backfill',
    { method: 'POST' },
    'Start TTS backfill',
  );
};

/** Poll the server-side backfill progress. */
export const getTtsBackfillStatus = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    '/api/tts/backfill',
    undefined,
    'Load TTS backfill status',
  );
};
