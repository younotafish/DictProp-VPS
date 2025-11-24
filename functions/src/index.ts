import { onCall, HttpsError } from "firebase-functions/v2/https";
import { GoogleGenAI, Schema, Type } from "@google/genai";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Define the secret parameter
const geminiApiKey = defineSecret("GEMINI_API_KEY");

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
Do not just define. Explain nuance, and tone (formal vs casual) for American English.
Identify sophisticated, C1/C2 level, or idiomatic vocabulary within the input for the 'vocabs' list.
For the 'grammar' field, use Markdown formatting (bolding, bullet points) to make it readable.
`;

export const analyzeInput = onCall({ secrets: [geminiApiKey], cors: true }, async (request) => {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY is not set');
  }
  
  const text = request.data.text;
  if (!text) {
    throw new HttpsError('invalid-argument', 'The function must be called with one argument "text" containing the input text.');
  }

  const ai = new GoogleGenAI({ apiKey });

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
    return data;
  } catch (error: any) {
    logger.error("Analysis failed", error);
    
    const msg = error.message || '';
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED') || 
        error.status === 429 || 
        error.status === 'RESOURCE_EXHAUSTED';

    if (isQuota) {
        throw new HttpsError('resource-exhausted', "QUOTA_EXCEEDED");
    }
    throw new HttpsError('internal', error.message);
  }
});

export const generateIllustration = onCall({ secrets: [geminiApiKey], cors: true }, async (request) => {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY is not set');
  }

  const prompt = request.data.prompt;
  const aspectRatio = request.data.aspectRatio || '1:1';

  if (!prompt) {
    throw new HttpsError('invalid-argument', 'Prompt is required');
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.` }]
      },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio,
        }
      }
    });

    // Extract image
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return {
          imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        };
      }
    }
    return { imageData: undefined };
  } catch (error: any) {
    const msg = error.message || '';
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED');

    if (isQuota) {
        logger.warn("Image generation skipped: Quota exceeded.");
        return { imageData: undefined, error: "QUOTA_EXCEEDED" };
    } else {
        logger.warn("Image generation failed", error);
        throw new HttpsError('internal', error.message);
    }
  }
});

