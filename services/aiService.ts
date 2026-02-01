import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { SearchResult } from "../types";
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

  const analyzeInputFn = httpsCallable(functions, 'analyzeInput');
  
  try {
    const result = await analyzeInputFn({ text });
    const data = result.data as any;
    
    // Augment with IDs and filter out invalid items
    const vocabs = (data.vocabs || [])
        .filter((v: any) => v && typeof v.word === 'string' && v.word.trim().length > 0)
        .map((v: any) => ({ ...v, id: generateId() }));

    return {
      id: generateId(),
      query: data.query || text, // Use translated query from server if available
      translation: data.translation,
      grammar: data.grammar,
      visualKeyword: data.visualKeyword,
      pronunciation: data.pronunciation,
      vocabs: vocabs,
      timestamp: Date.now(),
      originalQuery: data.originalQuery // Original Chinese input if translated
    };
  } catch (error: any) {
    logError("Analysis failed", error);
    
    const msg = error.message || '';
    // Check for quota errors propagated from the server function
    const isQuota = 
        msg.includes('QUOTA_EXCEEDED') || 
        msg.includes('resource-exhausted') ||
        error.code === 'resource-exhausted';

    if (isQuota) {
        throw new Error("QUOTA_EXCEEDED");
    }
    throw error;
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
