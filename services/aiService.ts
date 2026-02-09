import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { SearchResult, ComparisonResult } from "../types";
import { log, warn, error as logError } from "./logger";

// Internal ID generator to avoid external dependency issues
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const analyzeInput = async (text: string): Promise<SearchResult> => {
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot analyze empty text");
  }
  
  if (!functions) {
      throw new Error("Firebase functions not initialized. Check your Firebase configuration.");
  }

  const analyzeInputFn = httpsCallable(functions, 'analyzeInput', { timeout: 300000 });
  
  const attemptCall = async (): Promise<SearchResult> => {
    const result = await analyzeInputFn({ text });
    const data = result.data as any;
    
    // Augment with IDs and filter out invalid items
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
      vocabs: vocabs,
      timestamp: Date.now(),
      originalQuery: data.originalQuery
    };
  };
  
  try {
    return await attemptCall();
  } catch (error: any) {
    const msg = error.message || '';
    const code = error.code || '';
    
    // Check for quota errors
    const isQuota = 
        msg.includes('QUOTA_EXCEEDED') || 
        msg.includes('resource-exhausted') ||
        code === 'functions/resource-exhausted';
    if (isQuota) {
        throw new Error("QUOTA_EXCEEDED");
    }
    
    // Check for timeout/abort errors — retry once
    const isAbort = 
        msg.includes('aborted') ||
        msg.includes('deadline-exceeded') ||
        msg.includes('timed out') ||
        msg.includes('DEADLINE_EXCEEDED') ||
        code === 'functions/deadline-exceeded' ||
        error.name === 'AbortError';
    
    if (isAbort) {
      warn("Search timed out, retrying once...");
      try {
        return await attemptCall();
      } catch (retryError: any) {
        logError("Retry also failed", retryError);
        throw new Error("Search timed out. The AI service may be busy — please try again.");
      }
    }
    
    logError("Analysis failed", error);
    throw new Error(msg || 'Search failed. Please try again.');
  }
};

/**
 * A word detected in text by the AI scanner (lightweight — no full analysis).
 */
export interface DetectedWord {
  word: string;    // Base/dictionary form
  context: string; // Fragment from the original text
  level: string;   // e.g. "C1", "C2", "idiom", "phrasal verb"
  reason: string;  // Why it's worth studying
}

/**
 * Lightweight vocabulary detection from a pasted text passage.
 * Step 1 of the Text Analyzer: AI scans and identifies interesting words.
 * Step 2 uses the existing analyzeInput() per selected word.
 */
export const detectVocabulary = async (text: string): Promise<DetectedWord[]> => {
  if (!text || text.trim().length < 10) {
    throw new Error("Please provide a longer text passage to analyze.");
  }

  if (!functions) {
    throw new Error("Firebase functions not initialized. Check your Firebase configuration.");
  }

  const detectFn = httpsCallable(functions, 'extractVocabulary', { timeout: 120000 });

  try {
    log("[detectVocabulary] Scanning text...");
    const result = await detectFn({ text });
    const data = result.data as any;

    const words: DetectedWord[] = (data.words || [])
      .filter((w: any) => w && typeof w.word === 'string' && w.word.trim().length > 0)
      .map((w: any) => ({
        word: w.word.trim(),
        context: w.context || '',
        level: w.level || 'C1',
        reason: w.reason || '',
      }));

    log(`[detectVocabulary] Detected ${words.length} interesting words`);
    return words;
  } catch (error: any) {
    const msg = error.message || '';
    const code = error.code || '';

    if (msg.includes('QUOTA_EXCEEDED') || code === 'functions/resource-exhausted') {
      throw new Error("QUOTA_EXCEEDED");
    }

    const isAbort =
      msg.includes('aborted') ||
      msg.includes('deadline-exceeded') ||
      msg.includes('timed out') ||
      code === 'functions/deadline-exceeded';

    if (isAbort) {
      throw new Error("Scanning timed out. Try again with a shorter text.");
    }

    logError("Vocabulary detection failed", error);
    throw new Error(msg || 'Vocabulary detection failed. Please try again.');
  }
};

/**
 * Transcribe audio using DeepInfra Whisper Large V3 Turbo
 * @param audioBlob - The recorded audio blob
 * @returns Transcribed text
 */
export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  if (!functions) {
    throw new Error("Firebase functions not initialized. Check your Firebase configuration.");
  }

  log("[transcribeAudio] Starting transcription...");

  // Convert blob to base64
  const arrayBuffer = await audioBlob.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
  );

  const transcribeAudioFn = httpsCallable(functions, 'transcribeAudio');

  try {
    const result = await transcribeAudioFn({ 
      audio: base64, 
      mimeType: audioBlob.type || 'audio/webm' 
    });
    const data = result.data as any;
    
    log("[transcribeAudio] Transcription successful:", data.text);
    return data.text || '';
  } catch (error: any) {
    logError("Transcription failed", error);
    
    const msg = error.message || '';
    if (msg.includes('QUOTA_EXCEEDED') || error.code === 'resource-exhausted') {
      throw new Error("QUOTA_EXCEEDED");
    }
    throw error;
  }
};

/**
 * Compare 2-3 words with AI-generated nuance analysis.
 * Returns structured comparison with dimensions, examples, and verdict.
 */
export const compareWords = async (words: string[]): Promise<ComparisonResult> => {
  if (!words || words.length < 2 || words.length > 3) {
    throw new Error("Please provide 2-3 words to compare.");
  }

  if (!functions) {
    throw new Error("Firebase functions not initialized. Check your Firebase configuration.");
  }

  const compareWordsFn = httpsCallable(functions, 'compareWords', { timeout: 120000 });

  const attemptCall = async (): Promise<ComparisonResult> => {
    log(`[compareWords] Comparing: ${words.join(', ')}`);
    const result = await compareWordsFn({ words });
    const data = result.data as any;

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
    const code = error.code || '';

    if (msg.includes('QUOTA_EXCEEDED') || msg.includes('resource-exhausted') || code === 'functions/resource-exhausted') {
      throw new Error("QUOTA_EXCEEDED");
    }

    const isAbort =
      msg.includes('aborted') ||
      msg.includes('deadline-exceeded') ||
      msg.includes('timed out') ||
      msg.includes('DEADLINE_EXCEEDED') ||
      code === 'functions/deadline-exceeded' ||
      error.name === 'AbortError';

    if (isAbort) {
      warn("Comparison timed out, retrying once...");
      try {
        return await attemptCall();
      } catch (retryError: any) {
        logError("Comparison retry also failed", retryError);
        throw new Error("Comparison timed out. The AI service may be busy — please try again.");
      }
    }

    logError("Word comparison failed", error);
    throw new Error(msg || 'Word comparison failed. Please try again.');
  }
};

/**
 * Generate an illustration using DeepInfra FLUX Schnell
 * Returns base64 image data directly
 */
export const generateIllustration = async (prompt: string, aspectRatio: '16:9' | '9:16' | '4:3' | '1:1' = '1:1'): Promise<string | undefined> => {
  log(`[generateIllustration] Requesting image with aspect ratio: ${aspectRatio}`);
  
  if (!functions) {
      warn("Firebase functions not initialized, skipping image generation");
      return undefined;
  }

  const generateIllustrationFn = httpsCallable(functions, 'generateIllustration');

  try {
    const result = await generateIllustrationFn({ prompt, aspectRatio });
    const data = result.data as any;
    
    if (data.error === "QUOTA_EXCEEDED") {
        warn("Image generation skipped: Quota exceeded.");
        return undefined;
    }
    
    return data.imageData; // Return base64 directly
  } catch (error: any) {
    warn("Image generation failed", error);
    return undefined; 
  }
};
