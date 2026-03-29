import { StoredItem, SearchResult, ComparisonResult } from '../types';
import { log, warn, error as logError } from './logger';

// Same origin — Hono serves both API and static files
const API_BASE = '';

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

export const loadAllItems = async (): Promise<StoredItem[]> => {
  const res = await fetch(`${API_BASE}/api/items`);
  if (!res.ok) throw new Error(`Failed to load items: ${res.status}`);
  return res.json();
};

export const loadItemsSince = async (since: number): Promise<StoredItem[]> => {
  const res = await fetch(`${API_BASE}/api/items?since=${since}`);
  if (!res.ok) throw new Error(`Failed to load items: ${res.status}`);
  return res.json();
};

export const loadSingleItem = async (itemId: string): Promise<StoredItem | null> => {
  const res = await fetch(`${API_BASE}/api/items/${itemId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load item: ${res.status}`);
  return res.json();
};

export const saveItems = async (items: StoredItem[]): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/items`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  if (!res.ok) throw new Error(`Failed to save items: ${res.status}`);
};

export const deleteItem = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/items/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete item: ${res.status}`);
};

/**
 * Fetch a single item's image as a base64 data URI via the binary image endpoint.
 * Returns null if the item has no image.
 */
export const loadItemImage = async (itemId: string): Promise<string | null> => {
  try {
    const res = await fetch(`${API_BASE}/api/items/${itemId}/image`);
    if (!res.ok) return null;

    const contentType = res.headers.get('Content-Type') || 'image/png';
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
};

// ============================================================================
// AI API (replaces aiService.ts)
// ============================================================================

export const analyzeInput = async (text: string): Promise<SearchResult> => {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot analyze empty text");
  }

  const attemptCall = async (): Promise<SearchResult> => {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
      throw new Error(errText || `Analysis failed: ${res.status}`);
    }

    const data = await res.json();

    const vocabs = (data.vocabs || [])
      .filter((v: any) => v && typeof v.word === 'string' && v.word.trim().length > 0)
      .map((v: any) => ({ ...v, id: generateId() }));

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

    // Retry once on timeout
    if (msg.includes('timed out') || msg.includes('504') || error.name === 'AbortError') {
      warn('Search timed out, retrying once...');
      try {
        return await attemptCall();
      } catch (retryError: any) {
        logError('Retry also failed', retryError);
        throw new Error('Search timed out. The AI service may be busy — please try again.');
      }
    }

    logError('Analysis failed', error);
    throw new Error(msg || 'Search failed. Please try again.');
  }
};

export interface DetectedWord {
  word: string;
  context: string;
  level: string;
  reason: string;
}

export const detectVocabulary = async (text: string): Promise<DetectedWord[]> => {
  if (!text || text.trim().length < 10) {
    throw new Error('Please provide a longer text passage to analyze.');
  }

  const res = await fetch(`${API_BASE}/api/extract-vocabulary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
    const errText = await res.text();
    throw new Error(errText || 'Vocabulary detection failed.');
  }

  const data = await res.json();
  return (data.words || []).map((w: any) => ({
    word: w.word.trim(),
    context: w.context || '',
    level: w.level || 'C1',
    reason: w.reason || '',
  }));
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
  if (!words || words.length < 2 || words.length > 3) {
    throw new Error('Please provide 2-3 words to compare.');
  }

  const attemptCall = async (): Promise<ComparisonResult> => {
    const res = await fetch(`${API_BASE}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words }),
    });

    if (!res.ok) {
      if (res.status === 429) throw new Error('QUOTA_EXCEEDED');
      const errText = await res.text();
      throw new Error(errText || 'Comparison failed.');
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

    if (msg.includes('timed out') || msg.includes('504') || error.name === 'AbortError') {
      warn('Comparison timed out, retrying once...');
      try {
        return await attemptCall();
      } catch (retryError: any) {
        logError('Comparison retry also failed', retryError);
        throw new Error('Comparison timed out. The AI service may be busy — please try again.');
      }
    }

    logError('Word comparison failed', error);
    throw new Error(msg || 'Word comparison failed. Please try again.');
  }
};

export const generateIllustration = async (
  prompt: string,
  aspectRatio: '16:9' | '9:16' | '4:3' | '1:1' = '1:1'
): Promise<string | undefined> => {
  log(`[generateIllustration] Requesting image with aspect ratio: ${aspectRatio}`);

  try {
    const res = await fetch(`${API_BASE}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, aspectRatio }),
    });

    if (!res.ok) {
      warn('Image generation failed:', res.status);
      return undefined;
    }

    const data = await res.json();
    if (data.error === 'QUOTA_EXCEEDED') {
      warn('Image generation skipped: Quota exceeded.');
      return undefined;
    }

    return data.imageData;
  } catch (error: any) {
    warn('Image generation failed', error);
    return undefined;
  }
};

// ============================================================================
// Content hashing (moved from firebase.ts — needed for dirty tracking)
// ============================================================================

const hashString = (str: string): string => {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 << 5) + h1) + c;
    h1 = h1 & h1;
    h2 = ((h2 << 5) + h2) + c;
    h2 = h2 & h2;
  }
  return Math.abs(h1).toString(36) + Math.abs(h2).toString(36);
};

const hashCache = new WeakMap<StoredItem, string>();

// Strip image markers/base64 from data before hashing so that
// items with 'idb:stored' or 'server:has_image' don't hash differently from
// items with real base64 or no image at all.
const stripImageForHash = (data: any): any => {
  if (!data) return data;
  const cleaned = { ...data };
  if (cleaned.imageUrl && !cleaned.imageUrl.startsWith('http')) {
    delete cleaned.imageUrl;
  }
  if (Array.isArray(cleaned.vocabs)) {
    cleaned.vocabs = cleaned.vocabs.map((v: any) => {
      if (v?.imageUrl && !v.imageUrl.startsWith('http')) {
        const { imageUrl, ...rest } = v;
        return rest;
      }
      return v;
    });
  }
  return cleaned;
};

export const getItemContentHash = (item: StoredItem): string => {
  const cached = hashCache.get(item);
  if (cached) return cached;

  const contentToHash = {
    type: item.type,
    data: stripImageForHash(item.data),
    srs: item.srs,
    isDeleted: item.isDeleted,
    isArchived: item.isArchived,
  };

  const hash = hashString(JSON.stringify(contentToHash));
  hashCache.set(item, hash);
  return hash;
};
