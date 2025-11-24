import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { SearchResult } from "../types";

// Internal ID generator to avoid external dependency issues
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const analyzeInput = async (text: string): Promise<SearchResult> => {
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
      query: text,
      translation: data.translation,
      grammar: data.grammar,
      visualKeyword: data.visualKeyword,
      pronunciation: data.pronunciation,
      vocabs: vocabs,
      timestamp: Date.now()
    };
  } catch (error: any) {
    console.error("Analysis failed", error);
    
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

export const generateIllustration = async (prompt: string, aspectRatio: '16:9' | '4:3' | '1:1' = '1:1'): Promise<string | undefined> => {
  if (!functions) {
      console.warn("Firebase functions not initialized, skipping image generation");
      return undefined;
  }

  const generateIllustrationFn = httpsCallable(functions, 'generateIllustration');

  try {
    const result = await generateIllustrationFn({ prompt, aspectRatio });
    const data = result.data as any;
    
    if (data.error === "QUOTA_EXCEEDED") {
        console.warn("Image generation skipped: Quota exceeded.");
        return undefined;
    }
    
    return data.imageData;
  } catch (error: any) {
    console.warn("Image generation failed", error);
    return undefined; 
  }
};
