
import { GoogleGenAI, Schema, Type } from "@google/genai";
import { SearchResult, VocabCard } from "../types";

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// Internal ID generator to avoid external dependency issues
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

const vocabSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING, description: "The vocabulary word found in input" },
    chinese: { type: Type.STRING, description: "Chinese translation" },
    ipa: { type: Type.STRING, description: "American IPA with stress marks" },
    definition: { type: Type.STRING, description: "Original English definition (core sense)" },
    synonyms: { type: Type.ARRAY, items: { type: Type.STRING } },
    antonyms: { type: Type.ARRAY, items: { type: Type.STRING } },
    examples: { type: Type.ARRAY, items: { type: Type.STRING }, description: "2 natural contemporary sentences" },
    history: { type: Type.STRING, description: "Brief etymology/origin (1-2 lines)" },
    register: { type: Type.STRING, description: "Frequency/register note (formal, slang, etc.)" },
    mnemonic: { type: Type.STRING, description: "A simple memory aid" },
    imagePrompt: { type: Type.STRING, description: "A prompt to generate an illustrative image for this specific word" }
  },
  required: ["word", "chinese", "ipa", "definition", "synonyms", "antonyms", "examples", "history", "register", "mnemonic", "imagePrompt"]
};

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    translation: { type: Type.STRING, description: "Precise translation of the full input" },
    grammar: { type: Type.STRING, description: "Markdown explanation of grammar, nuance, tone, and register." },
    visualKeyword: { type: Type.STRING, description: "One single visual keyword to represent the whole concept for image generation" },
    pronunciation: { type: Type.STRING, description: "IPA or phonetic breakdown of the full input phrase" },
    vocabs: { 
      type: Type.ARRAY, 
      items: vocabSchema,
      description: "List of interesting/uncommon/C1 vocabulary found in the input"
    }
  },
  required: ["translation", "grammar", "visualKeyword", "pronunciation", "vocabs"]
};

const SYSTEM_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach. 
Your goal is to take any input (word, phrase, sentence) and break it down into a structured mini-lesson.
Do not just define. Explain nuance, register (formal vs casual), and tone.
Identify sophisticated, C1/C2 level, or idiomatic vocabulary within the input for the 'vocabs' list.
For the 'grammar' field, use Markdown formatting (bolding, bullet points) to make it readable.
`;

export const analyzeInput = async (text: string): Promise<SearchResult> => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze this English input for a C1 learner: "${text}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        systemInstruction: SYSTEM_INSTRUCTION,
      }
    });

    const data = JSON.parse(response.text || "{}");
    
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
    // Robust check for 429/Quota errors across different error object structures
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED') || 
        error.status === 429 || 
        error.status === 'RESOURCE_EXHAUSTED' ||
        // Check nested error object often returned by API
        error.error?.code === 429 ||
        error.error?.status === 'RESOURCE_EXHAUSTED' ||
        error.error?.message?.includes('RESOURCE_EXHAUSTED');

    if (isQuota) {
        throw new Error("QUOTA_EXCEEDED");
    }
    throw error;
  }
};

export const generateIllustration = async (prompt: string, aspectRatio: '16:9' | '4:3' | '1:1' = '1:1'): Promise<string | undefined> => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.` }]
      },
      config: {
        imageConfig: {
            aspectRatio: aspectRatio,
            // imageSize: '1K' // Not supported for gemini-2.5-flash-image, only for pro-image-preview
        }
      }
    });

    // Extract image
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    return undefined;
  } catch (error: any) {
    const msg = error.message || '';
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED') ||
        error.error?.code === 429;

    if (isQuota) {
        console.warn("Image generation skipped: Quota exceeded.");
    } else {
        console.warn("Image generation failed", error);
    }
    return undefined; // Fail silently for images, not critical
  }
};
