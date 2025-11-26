import { onCall, HttpsError } from "firebase-functions/v2/https";
import { GoogleGenAI, Schema, Type } from "@google/genai";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Define the secret parameter
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Vocab card schema (shared between both modes)
const vocabSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING, description: "The vocabulary word or phrase" },
    sense: { type: Type.STRING, description: "Brief label for this specific meaning (e.g., 'noun: financial', 'verb: to rely on')" },
    chinese: { type: Type.STRING, description: "Chinese translation for THIS specific meaning only" },
    ipa: { type: Type.STRING, description: "American IPA with stress marks" },
    definition: { type: Type.STRING, description: "Original English definition for THIS specific meaning/sense" },
    synonyms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Synonyms for THIS specific meaning" },
    antonyms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Antonyms for THIS specific meaning" },
    examples: { type: Type.ARRAY, items: { type: Type.STRING }, description: "2 natural contemporary sentences showing THIS specific meaning" },
    history: { type: Type.STRING, description: "Brief etymology/origin (1-2 lines)" },
    register: { type: Type.STRING, description: "Frequency/register note (formal, slang, etc.)" },
    mnemonic: { type: Type.STRING, description: "A simple memory aid for THIS specific meaning" },
    imagePrompt: { type: Type.STRING, description: "A prompt to generate an illustrative image for THIS specific meaning" }
  },
  required: ["word", "sense", "chinese", "ipa", "definition", "synonyms", "antonyms", "examples", "history", "register", "mnemonic", "imagePrompt"]
};

// Schema for WORD/PHRASE mode - vocabulary only
const wordModeSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    vocabs: { 
      type: Type.ARRAY, 
      items: vocabSchema,
      description: "All meanings/senses of this word or phrase as separate cards"
    }
  },
  required: ["vocabs"]
};

// Schema for SENTENCE mode - full analysis
const sentenceModeSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    translation: { type: Type.STRING, description: "Precise Chinese translation of the full sentence" },
    grammar: { type: Type.STRING, description: "Markdown explanation of grammar, nuance, tone, and register." },
    visualKeyword: { type: Type.STRING, description: "One single visual keyword to represent the whole concept for image generation" },
    pronunciation: { type: Type.STRING, description: "IPA or phonetic breakdown of the full input" },
    vocabs: { 
      type: Type.ARRAY, 
      items: vocabSchema,
      description: "List of interesting/uncommon/C1 vocabulary found in the sentence"
    }
  },
  required: ["translation", "grammar", "visualKeyword", "pronunciation", "vocabs"]
};

// System instruction for WORD/PHRASE mode
const WORD_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SINGLE WORD or SHORT PHRASE (not a full sentence).

Your task: Create comprehensive vocabulary cards for this word/phrase.

CRITICAL - MULTIPLE MEANINGS:
You MUST create SEPARATE vocab cards for EACH distinct meaning or sense of the word/phrase.
- Different parts of speech = different cards (noun vs verb vs adjective)
- Different contexts/domains = different cards (technical vs casual, literal vs figurative)
- Different common usages = different cards

Example: "bank" should produce 3+ cards:
1. bank (noun: finance) - "A financial institution..."
2. bank (noun: geography) - "The side of a river..."  
3. bank (verb: to rely) - "To depend on something..."
4. bank (verb: aviation) - "To tilt an aircraft..."

Each card MUST have:
- The SAME 'word' field (the original input)
- A UNIQUE 'sense' field (e.g., "noun: emotion", "verb: to cause", "adj: describing")
- Definition, examples, synonyms, antonyms specific to THAT meaning only
- Different Chinese translations for each sense
- Mnemonic specific to that meaning

Be thorough - include common AND less common meanings. This helps learners master all usages.
`;

// System instruction for SENTENCE mode  
const SENTENCE_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SENTENCE or longer text.

Your task: Provide a comprehensive analysis including:
1. translation - Precise Chinese translation
2. grammar - Markdown explanation of grammar points, nuance, tone, and register
3. visualKeyword - One keyword for image generation
4. pronunciation - IPA for the full sentence
5. vocabs - Extract interesting/uncommon/C1+ vocabulary from the sentence

For the 'grammar' field, use Markdown formatting (bolding, bullet points) to make it readable.
Focus on what makes this sentence interesting for a C1 learner.

For vocabs: Only extract words that are C1/C2 level, idiomatic, or have interesting nuance.
If a vocab word has multiple meanings, create separate cards for each relevant meaning.
`;

// Helper function to detect if input is a word/phrase or a sentence
function isWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  
  // Single word is definitely word mode
  if (words.length === 1) return true;
  
  // 2-4 words without sentence-ending punctuation is likely a phrase
  if (words.length <= 4 && !/[.!?]$/.test(trimmed)) return true;
  
  // Check for sentence structure indicators
  const hasSentenceStructure = 
    /[.!?]$/.test(trimmed) || // Ends with sentence punctuation
    words.length > 6 || // Long enough to be a sentence
    /^(I|You|He|She|It|We|They|The|A|An|This|That|There|Here)\s/i.test(trimmed) || // Starts with common sentence starters
    /\b(is|are|was|were|have|has|had|do|does|did|will|would|could|should|can|may|might)\b/i.test(trimmed); // Contains auxiliary verbs
  
  return !hasSentenceStructure;
}

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
  
  // Detect input type
  const isWord = isWordOrPhrase(text);
  logger.info(`Input "${text}" detected as: ${isWord ? 'WORD/PHRASE' : 'SENTENCE'}`);

  try {
    if (isWord) {
      // WORD/PHRASE MODE: Return vocabulary cards only
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Analyze this English word or phrase for a C1 learner. Create vocabulary cards for ALL its meanings: "${text}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: wordModeSchema,
          systemInstruction: WORD_MODE_INSTRUCTION,
        }
      });

      const data = JSON.parse(response.text || "{}");
      
      // Return in a format compatible with SearchResult but focused on vocabs
      // The frontend will detect this is word-mode by checking if translation is empty
      return {
        translation: "", // Empty indicates word mode
        grammar: "",
        visualKeyword: data.vocabs?.[0]?.word || text,
        pronunciation: data.vocabs?.[0]?.ipa || "",
        vocabs: data.vocabs || []
      };
    } else {
      // SENTENCE MODE: Full analysis
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Analyze this English sentence for a C1 learner: "${text}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: sentenceModeSchema,
          systemInstruction: SENTENCE_MODE_INSTRUCTION,
        }
      });

      const data = JSON.parse(response.text || "{}");
      return data;
    }
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

