import { onCall, HttpsError } from "firebase-functions/v2/https";
import { GoogleGenAI, Schema, Type } from "@google/genai";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Define the secret parameters
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const replicateApiKey = defineSecret("REPLICATE_API_TOKEN");

// Vocab card schema (shared between both modes)
const vocabSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    word: { type: Type.STRING, description: "The vocabulary word or phrase" },
    sense: { type: Type.STRING, description: "Brief label for this specific meaning (e.g., 'noun: financial', 'verb: to rely on')" },
    chinese: { type: Type.STRING, description: "Chinese translation for THIS specific meaning only" },
    ipa: { type: Type.STRING, description: "American IPA with stress marks" },
    definition: { type: Type.STRING, description: "Original English definition for THIS specific meaning/sense" },
    forms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Different grammatical forms of the word (e.g., for 'run': runs, running, ran, run). Include verb conjugations, noun plurals, adjective forms, etc." },
    synonyms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Synonyms for THIS specific meaning" },
    antonyms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Antonyms for THIS specific meaning" },
    confusables: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Words easily confused with this word (similar spelling, sound, or meaning). E.g., affect/effect, accept/except, complement/compliment" },
    examples: { type: Type.ARRAY, items: { type: Type.STRING }, description: "2 natural contemporary sentences showing THIS specific meaning" },
    history: { type: Type.STRING, description: "Brief etymology/origin (1-2 lines)" },
    register: { type: Type.STRING, description: "Frequency/register note (formal, slang, etc.)" },
    mnemonic: { type: Type.STRING, description: "A simple memory aid for THIS specific meaning" },
    imagePrompt: { type: Type.STRING, description: "A prompt to generate an illustrative image for THIS specific meaning" }
  },
  required: ["word", "sense", "chinese", "ipa", "definition", "forms", "synonyms", "antonyms", "confusables", "examples", "history", "register", "mnemonic", "imagePrompt"]
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
      description: "List of interesting/uncommon/C1 vocabulary found in the sentence. Include phrasal verbs (e.g., 'bank on'), idioms, and multi-word expressions as complete phrases, not individual words. Each item gets full vocabulary card treatment."
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
You MUST create SEPARATE vocab cards for EACH distinct, uncommon meaning or sense of the word/phrase.
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
- Confusables: words often confused with this one (similar spelling, sound, or meaning)
  Examples: affect/effect, accept/except, complement/compliment, principal/principle
- Forms: different grammatical forms of the word
  For verbs: base, 3rd person singular, past tense, past participle, present participle (e.g., run → runs, ran, run, running)
  For nouns: singular, plural (e.g., child → children)
  For adjectives: comparative, superlative (e.g., big → bigger, biggest)

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

CRITICAL - VOCABULARY EXTRACTION:
Extract phrasal verbs, idioms, and multi-word expressions as COMPLETE phrases (not individual words).
- "bank on" should be extracted as "bank on" (not just "bank")
- "couldn't help but" should be extracted as "couldn't help but"
- "even though" can be extracted if it adds learning value

CRITICAL - INCLUDE ALL MEANINGS (most important rule):
Once a word/phrase is selected for extraction, you MUST include ALL its common meanings/senses as SEPARATE vocab cards.
Do NOT limit to only the meaning used in the sentence context!

Example: If extracting "zest" from a cooking sentence:
- Card 1: zest (noun: culinary) - "The outer peel of citrus fruit..."
- Card 2: zest (noun: enthusiasm) - "Great energy and enjoyment..."
The user should learn ALL meanings of the word, not just the one in context.

Example: If extracting "bank" from any sentence:
- Create cards for ALL meanings: financial institution, river bank, to rely on, to tilt aircraft, etc.

Each card MUST include ALL fields with the SAME depth as Word Mode:
- word, sense, chinese, ipa, definition, forms, synonyms, antonyms, confusables, examples, history, register, mnemonic, imagePrompt
- Forms: grammatical variations (e.g., "bank on" → banks on, banked on, banking on)
- Confusables: similar phrases that might be confused

Only extract words/phrases that are C1/C2 level, idiomatic, or have interesting nuance.
Be thorough - the user should get the same quality whether they search a word directly or extract it from a sentence.
`;

// Helper function to detect if input is a word/phrase or a sentence
function isWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  
  // Single word is definitely word mode
  if (words.length === 1) return true;
  
  const endsWithPunctuation = /[.!?]$/.test(trimmed);
  if (endsWithPunctuation) return false; // Explicit sentence-ending punctuation

  // 6+ words → sentence mode (per PRODUCT_SUMMARY detection rules)
  if (words.length >= 6) return false;

  // Check for sentence structure indicators
  const startsLikeSentence = /^(I|You|He|She|It|We|They|The|A|An|This|That|There|Here)\s/i.test(trimmed);
  const hasAuxVerb = /\b(is|are|was|were|have|has|had|do|does|did|will|would|could|should|can|may|might)\b/i.test(trimmed);

  if (startsLikeSentence || hasAuxVerb) return false;

  // Otherwise treat 2-5 word inputs without punctuation as word/phrase mode
  return true;
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

export const generateIllustration = onCall({ secrets: [replicateApiKey], cors: true }, async (request) => {
  const apiKey = replicateApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'REPLICATE_API_TOKEN is not set');
  }

  const prompt = request.data.prompt;
  const aspectRatio = request.data.aspectRatio || '1:1';

  if (!prompt) {
    throw new HttpsError('invalid-argument', 'Prompt is required');
  }

  try {
    // Start prediction with Flux Schnell (sync mode with Prefer: wait)
    const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.`,
          aspect_ratio: aspectRatio,
          output_format: 'webp',
          output_quality: 50,  // Reduced from 80 to keep images under 200KB
          num_outputs: 1,
        }
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const status = response.status;
      
      // Check for rate limit / billing issues (use loose equality for safety)
      if (status == 429 || status == 402) {
        logger.warn("Replicate rate limit hit:", status, errorData);
        return { imageData: undefined, error: "QUOTA_EXCEEDED" };
      }
      
      logger.error("Replicate API error:", status, errorData);
      throw new Error(`Replicate API error: ${status}`);
    }

    const prediction = await response.json();

    // Check if prediction completed
    if (prediction.status === 'succeeded' && prediction.output && prediction.output.length > 0) {
      const imageUrl = prediction.output[0];
      
      // Fetch the image and convert to base64
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error('Failed to fetch generated image');
      }
      
      const arrayBuffer = await imageResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = imageResponse.headers.get('content-type') || 'image/webp';
      
      return { imageData: `data:${mimeType};base64,${base64}` };
    }

    // If prediction failed
    if (prediction.status === 'failed') {
      logger.error("Prediction failed:", prediction.error);
      throw new Error(prediction.error || 'Image generation failed');
    }

    logger.warn("Prediction not completed:", prediction.status);
    return { imageData: undefined };

  } catch (error: any) {
    const msg = error.message || '';
    const isQuota = 
        msg.includes('429') || 
        msg.includes('402') ||
        msg.includes('quota') || 
        msg.includes('billing');

    if (isQuota) {
      logger.warn("Image generation skipped: Quota/billing issue.");
      return { imageData: undefined, error: "QUOTA_EXCEEDED" };
    } else {
      logger.warn("Image generation failed", error);
      throw new HttpsError('internal', error.message);
    }
  }
});

