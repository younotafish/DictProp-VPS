import { onCall, HttpsError } from "firebase-functions/v2/https";
import { GoogleGenAI, Schema, Type } from "@google/genai";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Define the secret parameters
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const replicateApiKey = defineSecret("REPLICATE_API_TOKEN");
const deepinfraApiKey = defineSecret("DEEPINFRA_API_KEY");

// ============================================================================
// DeepSeek-V3 Helper (Primary text model via DeepInfra)
// ============================================================================

const DEEPSEEK_TIMEOUT_MS = 30000; // 30 second timeout

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Timeout wrapper for fetch
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callDeepSeek(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<any> {
  const response = await fetchWithTimeout(
    'https://api.deepinfra.com/v1/openai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      }),
    },
    DEEPSEEK_TIMEOUT_MS
  );

  if (!response.ok) {
    const status = response.status;
    const errorData = await response.json().catch(() => ({}));
    logger.warn("DeepSeek API error:", status, errorData);
    throw new Error(`DeepSeek API error: ${status}`);
  }

  const data: DeepSeekResponse = await response.json();
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error("DeepSeek returned empty response");
  }

  return JSON.parse(content);
}

// ============================================================================
// Response Validation (derisk DeepSeek's lack of native schema enforcement)
// ============================================================================

function validateTranslationResponse(data: any): boolean {
  return data && typeof data.english === 'string' && data.english.length > 0;
}

function validateVocabCard(vocab: any): boolean {
  if (!vocab || typeof vocab !== 'object') return false;
  
  const requiredStrings = ['word', 'sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt'];
  const requiredArrays = ['forms', 'synonyms', 'antonyms', 'confusables', 'examples'];
  
  for (const field of requiredStrings) {
    if (typeof vocab[field] !== 'string') return false;
  }
  
  for (const field of requiredArrays) {
    if (!Array.isArray(vocab[field])) return false;
  }
  
  return true;
}

function validateWordModeResponse(data: any): boolean {
  if (!data || !Array.isArray(data.vocabs)) return false;
  if (data.vocabs.length === 0) return false;
  
  // Validate at least the first vocab card has required structure
  return validateVocabCard(data.vocabs[0]);
}

function validateSentenceModeResponse(data: any): boolean {
  if (!data) return false;
  
  const requiredStrings = ['translation', 'grammar', 'visualKeyword', 'pronunciation'];
  for (const field of requiredStrings) {
    if (typeof data[field] !== 'string') return false;
  }
  
  if (!Array.isArray(data.vocabs)) return false;
  
  // If vocabs exist, validate they have proper structure
  if (data.vocabs.length > 0 && !validateVocabCard(data.vocabs[0])) {
    return false;
  }
  
  return true;
}

// ============================================================================
// Gemini Helper (Fallback text model)
// ============================================================================

async function callGemini(
  ai: GoogleGenAI,
  systemPrompt: string,
  userPrompt: string,
  schema: Schema
): Promise<any> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userPrompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: schema,
      systemInstruction: systemPrompt,
    }
  });

  return JSON.parse(response.text || "{}");
}

// ============================================================================
// JSON Schema descriptions for DeepSeek prompts
// ============================================================================

const VOCAB_SCHEMA_DESCRIPTION = `
Each vocab object MUST have these fields:
{
  "word": "string - The vocabulary word or phrase",
  "sense": "string - Brief label for this specific meaning (e.g., 'noun: financial', 'verb: to rely on')",
  "chinese": "string - Chinese translation for THIS specific meaning only",
  "ipa": "string - American IPA with stress marks",
  "definition": "string - Original English definition for THIS specific meaning/sense",
  "forms": ["array of strings - Different grammatical forms (e.g., runs, running, ran)"],
  "synonyms": ["array of strings - Synonyms for THIS specific meaning"],
  "antonyms": ["array of strings - Antonyms for THIS specific meaning"],
  "confusables": ["array of strings - Words easily confused with this (similar spelling, sound, or meaning)"],
  "examples": ["array of 2 strings - Natural contemporary sentences showing THIS specific meaning"],
  "history": "string - Brief etymology/origin (1-2 lines)",
  "register": "string - Frequency/register note (formal, slang, etc.)",
  "mnemonic": "string - A simple memory aid for THIS specific meaning",
  "imagePrompt": "string - A prompt to generate an illustrative image for THIS specific meaning"
}`;

const WORD_MODE_JSON_SCHEMA = `
You MUST respond with valid JSON in this exact format:
{
  "vocabs": [
    ${VOCAB_SCHEMA_DESCRIPTION}
  ]
}`;

const SENTENCE_MODE_JSON_SCHEMA = `
You MUST respond with valid JSON in this exact format:
{
  "translation": "string - Precise Chinese translation of the full sentence",
  "grammar": "string - Markdown explanation of grammar, nuance, tone, and register",
  "visualKeyword": "string - One single visual keyword to represent the whole concept for image generation",
  "pronunciation": "string - IPA or phonetic breakdown of the full input",
  "vocabs": [
    ${VOCAB_SCHEMA_DESCRIPTION}
  ]
}`;

const TRANSLATION_JSON_SCHEMA = `
You MUST respond with valid JSON in this exact format:
{
  "english": "string - Best natural English translation"
}`;

// ============================================================================
// Gemini Schema definitions (used for fallback with native schema enforcement)
// ============================================================================

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

// System instruction for WORD/PHRASE mode (base instruction)
const WORD_MODE_INSTRUCTION_BASE = `
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

// DeepSeek version (with JSON schema embedded)
const WORD_MODE_INSTRUCTION_DEEPSEEK = WORD_MODE_INSTRUCTION_BASE + WORD_MODE_JSON_SCHEMA;

// Gemini version (uses native schema, no need to embed)
const WORD_MODE_INSTRUCTION = WORD_MODE_INSTRUCTION_BASE;

// System instruction for SENTENCE mode (base instruction)
const SENTENCE_MODE_INSTRUCTION_BASE = `
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

CRITICAL - USE BASE/DICTIONARY FORMS:
Always convert detected words to their base/lemma form (the dictionary entry form):
- Verbs: "touted" → "tout", "running" → "run", "went" → "go", "has been" → "be"
- Phrasal verbs: Use base form of the main verb: "banked on" → "bank on", "looking forward to" → "look forward to"
- Adjectives: "happier" → "happy", "best" → "good"
- Nouns: Keep singular form when the plural is just adding -s/-es
The 'word' field should contain the base form that a learner would look up in a dictionary.

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

// DeepSeek version (with JSON schema embedded)
const SENTENCE_MODE_INSTRUCTION_DEEPSEEK = SENTENCE_MODE_INSTRUCTION_BASE + SENTENCE_MODE_JSON_SCHEMA;

// Gemini version (uses native schema, no need to embed)
const SENTENCE_MODE_INSTRUCTION = SENTENCE_MODE_INSTRUCTION_BASE;

// Helper function to detect if input contains Chinese characters
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// Schema for Chinese to English translation
const translationSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    english: { type: Type.STRING, description: "Best natural English translation" }
  },
  required: ["english"]
};

// Translation instruction (base)
const TRANSLATION_INSTRUCTION_BASE = `
You are a professional Chinese-English translator.
Translate the Chinese text to natural English.
Provide the single best translation that captures the meaning.
If the input contains both Chinese and English, translate only the Chinese parts and preserve the English.
For single words or short phrases, provide the most common English equivalent.
`;

// DeepSeek version (with JSON schema embedded)
const TRANSLATION_INSTRUCTION_DEEPSEEK = TRANSLATION_INSTRUCTION_BASE + TRANSLATION_JSON_SCHEMA;

// Gemini version (uses native schema)
const TRANSLATION_INSTRUCTION = TRANSLATION_INSTRUCTION_BASE;

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

export const analyzeInput = onCall({ secrets: [geminiApiKey, deepinfraApiKey], cors: true }, async (request) => {
  const geminiKey = geminiApiKey.value();
  const deepinfraKey = deepinfraApiKey.value();
  
  // We need at least one API key
  if (!geminiKey && !deepinfraKey) {
    throw new HttpsError('failed-precondition', 'No API keys configured (GEMINI_API_KEY or DEEPINFRA_API_KEY required)');
  }
  
  let text = request.data.text;
  if (!text) {
    throw new HttpsError('invalid-argument', 'The function must be called with one argument "text" containing the input text.');
  }

  // Initialize Gemini AI for fallback (only if key available)
  const ai = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : null;
  
  // Track original query if we need to translate from Chinese
  let originalQuery: string | undefined;
  
  // ============================================================================
  // TRANSLATION (if input contains Chinese)
  // ============================================================================
  if (containsChinese(text)) {
    logger.info(`Input "${text}" contains Chinese, translating first...`);
    originalQuery = text;
    
    const translationPrompt = `Translate this to English: "${text}"`;
    let translationSuccess = false;
    
    // Try DeepSeek first for translation
    if (deepinfraKey) {
      try {
        logger.info("Translating with DeepSeek-V3...");
        const translationData = await callDeepSeek(
          deepinfraKey,
          TRANSLATION_INSTRUCTION_DEEPSEEK,
          translationPrompt
        );
        
        // Validate response structure
        if (validateTranslationResponse(translationData)) {
          text = translationData.english;
          logger.info(`DeepSeek translated to: "${text}"`);
          translationSuccess = true;
        } else {
          logger.warn("DeepSeek translation response failed validation, trying Gemini fallback");
        }
      } catch (deepseekError: any) {
        const isTimeout = deepseekError.name === 'AbortError';
        logger.warn(`DeepSeek translation failed (${isTimeout ? 'timeout' : 'error'}), trying Gemini fallback:`, deepseekError.message);
      }
    }
    
    // Fallback to Gemini for translation
    if (!translationSuccess && ai) {
      try {
        logger.info("Translating with Gemini Flash (fallback)...");
        const translationData = await callGemini(
          ai,
          TRANSLATION_INSTRUCTION,
          translationPrompt,
          translationSchema
        );
        if (translationData.english) {
          text = translationData.english;
          logger.info(`Gemini translated to: "${text}"`);
          translationSuccess = true;
        }
      } catch (geminiError: any) {
        logger.warn("Gemini translation also failed:", geminiError.message);
      }
    }
    
    // If all translation failed, proceed with original text
    if (!translationSuccess) {
      logger.warn("Translation failed, proceeding with original text");
      originalQuery = undefined;
    }
  }
  
  // ============================================================================
  // ANALYSIS (Word/Phrase or Sentence mode)
  // ============================================================================
  const isWord = isWordOrPhrase(text);
  logger.info(`Input "${text}" detected as: ${isWord ? 'WORD/PHRASE' : 'SENTENCE'}`);

  const userPrompt = isWord
    ? `Analyze this English word or phrase for a C1 learner. Create vocabulary cards for ALL its meanings: "${text}"`
    : `Analyze this English sentence for a C1 learner: "${text}"`;

  let analysisData: any = null;
  let analysisError: any = null;

  // Try DeepSeek first
  if (deepinfraKey) {
    try {
      logger.info(`Analyzing with DeepSeek-V3 (${isWord ? 'word' : 'sentence'} mode)...`);
      const systemPrompt = isWord ? WORD_MODE_INSTRUCTION_DEEPSEEK : SENTENCE_MODE_INSTRUCTION_DEEPSEEK;
      const rawData = await callDeepSeek(deepinfraKey, systemPrompt, userPrompt);
      
      // Validate response structure before accepting
      const isValid = isWord 
        ? validateWordModeResponse(rawData)
        : validateSentenceModeResponse(rawData);
      
      if (isValid) {
        analysisData = rawData;
        logger.info("DeepSeek analysis succeeded and validated");
      } else {
        logger.warn("DeepSeek response failed validation, trying Gemini fallback");
        analysisError = new Error("DeepSeek response validation failed");
      }
    } catch (deepseekError: any) {
      const isTimeout = deepseekError.name === 'AbortError';
      logger.warn(`DeepSeek analysis failed (${isTimeout ? 'timeout' : 'error'}), trying Gemini fallback:`, deepseekError.message);
      analysisError = deepseekError;
    }
  }

  // Fallback to Gemini
  if (!analysisData && ai) {
    try {
      logger.info(`Analyzing with Gemini Flash (${isWord ? 'word' : 'sentence'} mode, fallback)...`);
      const systemPrompt = isWord ? WORD_MODE_INSTRUCTION : SENTENCE_MODE_INSTRUCTION;
      const schema = isWord ? wordModeSchema : sentenceModeSchema;
      analysisData = await callGemini(ai, systemPrompt, userPrompt, schema);
      logger.info("Gemini analysis succeeded");
    } catch (geminiError: any) {
      logger.error("Gemini analysis also failed:", geminiError.message);
      analysisError = geminiError;
    }
  }

  // If all providers failed, throw error
  if (!analysisData) {
    const msg = analysisError?.message || 'Analysis failed';
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED') || 
        analysisError?.status === 429 || 
        analysisError?.status === 'RESOURCE_EXHAUSTED';

    if (isQuota) {
      throw new HttpsError('resource-exhausted', "QUOTA_EXCEEDED");
    }
    throw new HttpsError('internal', msg);
  }

  // Format response
  if (isWord) {
    return {
      translation: "", // Empty indicates word mode
      grammar: "",
      visualKeyword: analysisData.vocabs?.[0]?.word || text,
      pronunciation: analysisData.vocabs?.[0]?.ipa || "",
      vocabs: analysisData.vocabs || [],
      originalQuery,
      query: text
    };
  } else {
    return {
      ...analysisData,
      originalQuery,
      query: text
    };
  }
});

// Convert aspect ratio to width/height for DeepInfra
const getImageDimensions = (aspectRatio: string): { width: number; height: number } => {
  switch (aspectRatio) {
    case '16:9': return { width: 1024, height: 576 };
    case '9:16': return { width: 576, height: 1024 };
    case '4:3': return { width: 896, height: 672 };
    case '3:4': return { width: 672, height: 896 };
    case '1:1': 
    default: return { width: 768, height: 768 };
  }
};

export const generateIllustration = onCall({ secrets: [deepinfraApiKey, replicateApiKey], cors: true }, async (request) => {
  const prompt = request.data.prompt;
  const aspectRatio = request.data.aspectRatio || '1:1';

  if (!prompt) {
    throw new HttpsError('invalid-argument', 'Prompt is required');
  }

  const styledPrompt = `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.`;
  const dimensions = getImageDimensions(aspectRatio);
  
  logger.info(`Generating image with aspect ratio: ${aspectRatio} (${dimensions.width}x${dimensions.height})`);

  // Try DeepInfra first (primary)
  const deepinfraKey = deepinfraApiKey.value();
  if (deepinfraKey) {
    try {
      logger.info("Trying DeepInfra FLUX Schnell...");
      const response = await fetch('https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepinfraKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: styledPrompt,
          width: dimensions.width,
          height: dimensions.height,
          num_inference_steps: 4,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        // DeepInfra returns images array with base64 data
        if (data.images && data.images.length > 0) {
          const base64Image = data.images[0];
          // DeepInfra returns raw base64, add data URI prefix
          const imageData = base64Image.startsWith('data:') 
            ? base64Image 
            : `data:image/png;base64,${base64Image}`;
          logger.info("DeepInfra succeeded");
          return { imageData };
        }
      } else {
        const status = response.status;
        const errorData = await response.json().catch(() => ({}));
        logger.warn("DeepInfra failed, falling back to Replicate:", status, errorData);
        
        // Check for quota issues - don't fallback, just return
        if (status == 429 || status == 402) {
          logger.warn("DeepInfra quota exceeded");
          // Still try fallback for quota issues
        }
      }
    } catch (deepinfraError: any) {
      logger.warn("DeepInfra error, falling back to Replicate:", deepinfraError.message);
    }
  } else {
    logger.warn("DEEPINFRA_API_KEY not set, using Replicate directly");
  }

  // Fallback to Replicate
  const replicateKey = replicateApiKey.value();
  if (!replicateKey) {
    logger.error("Neither DeepInfra nor Replicate API keys are available");
    return { imageData: undefined, error: "NO_API_KEY" };
  }

  try {
    logger.info("Trying Replicate Flux Schnell (fallback)...");
    const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: styledPrompt,
          aspect_ratio: aspectRatio,
          output_format: 'webp',
          output_quality: 50,
          num_outputs: 1,
        }
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const status = response.status;
      
      if (status == 429 || status == 402) {
        logger.warn("Replicate rate limit hit:", status, errorData);
        return { imageData: undefined, error: "QUOTA_EXCEEDED" };
      }
      
      logger.error("Replicate API error:", status, errorData);
      throw new Error(`Replicate API error: ${status}`);
    }

    const prediction = await response.json();

    if (prediction.status === 'succeeded' && prediction.output && prediction.output.length > 0) {
      const imageUrl = prediction.output[0];
      
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error('Failed to fetch generated image');
      }
      
      const arrayBuffer = await imageResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = imageResponse.headers.get('content-type') || 'image/webp';
      
      logger.info("Replicate succeeded");
      return { imageData: `data:${mimeType};base64,${base64}` };
    }

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

