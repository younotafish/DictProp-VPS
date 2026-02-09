import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";

// Initialize Firebase Admin SDK
admin.initializeApp();
const adminDb = admin.firestore();
const adminStorage = admin.storage();

// Define the secret parameters
const replicateApiKey = defineSecret("REPLICATE_API_TOKEN");
const deepinfraApiKey = defineSecret("DEEPINFRA_API_KEY");
const openaiApiKey = defineSecret("OPENAI_API_KEY");

// ============================================================================
// DeepSeek-V3 Helper (Text model via DeepInfra)
// ============================================================================

const DEEPSEEK_TIMEOUT_MS = 100000; // 100 second timeout

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

async function callDeepSeekOnce(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<any> {
  logger.info(`DeepSeek: calling API (key starts with ${apiKey.substring(0, 8)}..., timeout ${DEEPSEEK_TIMEOUT_MS}ms)`);
  
  let response: Response;
  try {
    response = await fetchWithTimeout(
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
  } catch (fetchErr: any) {
    logger.error(`DeepSeek: fetch failed - name: ${fetchErr.name}, message: ${fetchErr.message}`);
    throw fetchErr;
  }
  
  logger.info(`DeepSeek: got response status ${response.status}`);

  if (!response.ok) {
    const status = response.status;
    const errorData = await response.json().catch(() => ({}));
    logger.warn("DeepSeek API error:", status, JSON.stringify(errorData));
    throw new Error(`DeepSeek API error: ${status}`);
  }

  const data: DeepSeekResponse = await response.json();
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error("DeepSeek returned empty response");
  }

  // Extract JSON — model may wrap it in markdown code fences
  let jsonStr = content.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    logger.warn("JSON parse failed, attempting to extract JSON object from response");
    // Last resort: find first { ... } block
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      return JSON.parse(objMatch[0]);
    }
    throw new Error("Failed to parse JSON from DeepSeek response");
  }
}

// Retry wrapper for transient failures (timeout, 5xx errors)
async function callDeepSeek(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxRetries: number = 1
): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callDeepSeekOnce(apiKey, systemPrompt, userPrompt);
    } catch (error: any) {
      lastError = error;
      const msg = error.message || '';
      const isRetryable = 
        error.name === 'AbortError' || 
        msg.includes('aborted') ||
        msg.includes('DeepSeek API error: 5') || // 5xx server errors
        msg.includes('DeepSeek API error: 429') ||
        msg.includes('fetch failed');
      
      if (attempt < maxRetries && isRetryable) {
        logger.warn(`DeepSeek attempt ${attempt + 1} failed (${msg}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s backoff
        continue;
      }
    }
  }
  throw lastError;
}

// ============================================================================
// Response Validation
// ============================================================================

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
// JSON Schema descriptions for DeepSeek prompts
// ============================================================================

const VOCAB_SCHEMA_DESCRIPTION = `
Each vocab object MUST have these fields:
{
  "word": "string - The vocabulary word or phrase",
  "sense": "string - Brief label for this specific meaning (e.g., 'noun: financial', 'verb: to rely on')",
  "chinese": "string - Chinese translation for THIS specific meaning only",
  "ipa": "string - American English IPA pronunciation with stress marks (use General American accent, NOT British)",
  "definition": "string - Original English definition for THIS specific meaning/sense",
  "forms": ["array of strings - Different grammatical forms (e.g., runs, running, ran)"],
  "wordFamily": ["array of objects - Related words of different parts of speech, each with { word, pos, chinese }"],
  "synonyms": ["array of strings - Synonyms for THIS specific meaning"],
  "antonyms": ["array of strings - Antonyms for THIS specific meaning"],
  "confusables": ["array of strings - Words easily confused with this (similar spelling, sound, or meaning)"],
  "examples": ["array of 2 strings - Natural contemporary sentences showing THIS specific meaning"],
  "history": "string - Etymology and semantic evolution: Where the word comes from AND how/why it evolved to its current meaning. Explain the journey from original meaning to modern usage (2-3 sentences)",
  "register": "string - Frequency/register note (formal, slang, etc.)",
  "mnemonic": "string - A simple memory aid for THIS specific meaning",
  "imagePrompt": "string - A prompt to generate an illustrative image for THIS specific meaning"
}`;

const WORD_MODE_JSON_SCHEMA = `
You MUST respond with valid JSON in this exact format:
{
  "query": "string - The English word/phrase being analyzed. If the input was Chinese, this is the English equivalent you identified.",
  "vocabs": [
    ${VOCAB_SCHEMA_DESCRIPTION}
  ]
}`;

const SENTENCE_MODE_JSON_SCHEMA = `
You MUST respond with valid JSON in this exact format:
{
  "query": "string - The English sentence being analyzed. If the input was Chinese, this is the English translation.",
  "translation": "string - Precise Chinese translation of the full sentence",
  "grammar": "string - Markdown explanation of grammar, nuance, tone, and register",
  "visualKeyword": "string - One single visual keyword to represent the whole concept for image generation",
  "pronunciation": "string - American English IPA pronunciation of the full input (use General American accent, NOT British)",
  "vocabs": [
    ${VOCAB_SCHEMA_DESCRIPTION}
  ]
}`;

// System instruction for WORD/PHRASE mode
const WORD_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SINGLE WORD or SHORT PHRASE (not a full sentence).

Your task: Create comprehensive vocabulary cards for this word/phrase.

CRITICAL - HANDLE TYPOS AND MISSPELLINGS:
If the input appears to be misspelled or contains a typo, AUTOMATICALLY CORRECT IT to the most likely intended word.
- "potabel" → "potable"
- "recieve" → "receive"  
- "accomodate" → "accommodate"
- "definately" → "definitely"
- "occured" → "occurred"
Use your best judgment to determine what the user meant. The 'word' field should contain the CORRECT spelling.

CRITICAL - CHINESE INPUT:
If the input is in Chinese (e.g., 坚韧, 银行, 不屈不挠), identify the best English word or phrase equivalent and analyze THAT English word.
- "坚韧" → analyze "tenacity" / "resilience"
- "银行" → analyze "bank"
- "不屈不挠" → analyze "perseverance" or "indomitable"
- "打破僵局" → analyze "break the ice"
Set the 'query' field in your response to the English word/phrase you identified.
Create vocabulary cards for the English word, exactly as if the user had typed it in English.

CRITICAL - USE BASE/DICTIONARY FORMS:
If the input is an inflected form, you MUST normalize it to the base/lemma form (the dictionary entry form):
- Verbs: "hidden" → "hide", "running" → "run", "went" → "go", "touted" → "tout", "eaten" → "eat"
- Adjectives: "happier" → "happy", "best" → "good", "worse" → "bad"
- Nouns: "children" → "child", "mice" → "mouse" (irregular plurals only)
- Adverbs: "better" (as adverb) → "well"
The 'word' field in your response should contain the BASE FORM that a learner would look up in a dictionary.
Include the original input form in the 'forms' array.

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
- The SAME 'word' field (the BASE/DICTIONARY form, not the original inflected input)
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
- Word Family: related words derived from the same root but different parts of speech
  Each entry has { "word": "string", "pos": "noun/verb/adj/adv", "chinese": "string" }
  Examples for "create" (verb):
    { "word": "creation", "pos": "noun", "chinese": "创造（物）" }
    { "word": "creative", "pos": "adj", "chinese": "有创意的" }
    { "word": "creatively", "pos": "adv", "chinese": "创造性地" }
    { "word": "creator", "pos": "noun", "chinese": "创造者" }
    { "word": "creativity", "pos": "noun", "chinese": "创造力" }

Be thorough - include common AND less common meanings. This helps learners master all usages.

${WORD_MODE_JSON_SCHEMA}`;

// System instruction for SENTENCE mode
const SENTENCE_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SENTENCE or longer text.

CRITICAL - HANDLE TYPOS AND MISSPELLINGS:
If the input contains misspelled words or typos, AUTOMATICALLY CORRECT THEM when analyzing.
Treat the sentence as if it were spelled correctly. Extract vocabulary based on the corrected words.

CRITICAL - CHINESE INPUT:
If the input is in Chinese, translate it to natural English and analyze the English version.
- Set the 'query' field to the English translation of the sentence
- Set the 'translation' field to the original Chinese (or a refined version)
- Analyze grammar, pronunciation, and vocabulary based on the English equivalent
Treat the analysis exactly as if the user had entered the English sentence directly.

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

${SENTENCE_MODE_JSON_SCHEMA}`;

// Helper function to detect if input contains Chinese characters
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// Helper function to detect if input is a word/phrase or a sentence
function isWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();
  
  // Handle Chinese text specially (no spaces between words)
  if (containsChinese(trimmed)) {
    // Check for Chinese sentence-ending punctuation
    const hasChinesePunctuation = /[。！？]$/.test(trimmed);
    if (hasChinesePunctuation) return false; // Explicit sentence ending
    
    // Count Chinese characters (excluding punctuation)
    const chineseChars = trimmed.match(/[\u4e00-\u9fff]/g) || [];
    
    // 5+ Chinese characters likely indicates a sentence
    // (average Chinese word is 1-2 characters, so 5+ chars = 3+ words)
    if (chineseChars.length >= 5) return false;
    
    // Short Chinese input (1-4 chars) is likely a word/phrase
    return true;
  }
  
  // English logic: split by spaces
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

// ============================================================================
// Text Analyzer — Lightweight vocabulary detection from pasted text
// Step 1 only: Detect interesting words. Full analysis is done per-word
// via the existing analyzeInput function on the client side.
// ============================================================================

const TEXT_DETECT_INSTRUCTION = `
You are PopDict, an expert ESL vocabulary scanner.

Scan the user's text and identify all rare, advanced (C1/C2+), idiomatic, or interesting English vocabulary that would be worth studying for an intermediate-to-advanced learner.

## WHAT TO DETECT (in order of priority)
- Idioms and idiomatic expressions ("break the ice", "bite the bullet")
- Phrasal verbs with non-obvious meanings ("bank on", "come across")
- C1/C2 level vocabulary (tenacity, ephemeral, ubiquitous, etc.)
- Academic or formal register words
- Domain-specific terminology a learner might not know
- Words used in figurative, metaphorical, or unusual ways
- Interesting collocations and fixed expressions

## WHAT TO SKIP
- Common everyday words (go, make, have, take, get, do, say, think, know, want, like, etc.)
- Basic B1/B2 vocabulary that intermediate learners already know comfortably
- Proper nouns (names of people, places, brands)
- Function words (the, a, an, is, are, was, were, this, that, which, etc.)

## EXTRACTION COUNT
- Short text (under 50 words): 3-8 items
- Medium text (50-150 words): 5-12 items
- Long text (150+ words): 8-20 items

## CRITICAL RULES

USE BASE/DICTIONARY FORMS:
- Verbs: "hidden" → "hide", "running" → "run", "went" → "go", "touted" → "tout"
- Adjectives: "happier" → "happy", "best" → "good"
- Nouns: Irregular plurals only: "children" → "child"
- Phrasal verbs: "banked on" → "bank on", "looking forward to" → "look forward to"

CHINESE INPUT:
If the text is in Chinese, translate it to English first, then detect interesting English vocabulary.

You MUST respond with valid JSON in this exact format:
{
  "words": [
    {
      "word": "string - The word or expression in base/dictionary form",
      "context": "string - The original phrase from the text where this appears (5-15 words around it)",
      "level": "string - e.g. C1, C2, idiom, phrasal verb, formal, academic, literary",
      "reason": "string - One-line explanation of why this is worth studying"
    }
  ]
}

Return ONLY the word list. Do NOT provide full definitions, examples, etymology, or detailed analysis.
This is a quick scan — the user will choose which words to study in depth.`;

function validateDetectedWord(word: any): boolean {
  if (!word || typeof word !== 'object') return false;
  return (
    typeof word.word === 'string' && word.word.trim().length > 0 &&
    typeof word.context === 'string' &&
    typeof word.level === 'string' &&
    typeof word.reason === 'string'
  );
}

export const extractVocabulary = onCall({ secrets: [deepinfraApiKey], cors: true, timeoutSeconds: 120 }, async (request) => {
  const deepinfraKey = deepinfraApiKey.value();

  if (!deepinfraKey) {
    throw new HttpsError('failed-precondition', 'DEEPINFRA_API_KEY not configured');
  }

  const text = request.data.text;
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    throw new HttpsError('invalid-argument', 'Please provide a text passage of at least 10 characters.');
  }

  // Truncate very long texts to avoid token limits
  const maxChars = 5000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;

  const userPrompt = `Scan this text and identify all rare, advanced, or interesting vocabulary worth studying:\n\n"${truncatedText}"`;

  try {
    logger.info(`DetectVocabulary: Scanning text (${text.length} chars)...`);
    const rawData = await callDeepSeek(deepinfraKey, TEXT_DETECT_INSTRUCTION, userPrompt);

    // Validate
    if (!rawData || !Array.isArray(rawData.words) || rawData.words.length === 0) {
      logger.error("DetectVocabulary: No words detected");
      throw new HttpsError('internal', 'No interesting vocabulary found in the text. Try a text with more advanced or uncommon words.');
    }

    // Filter valid entries
    const validWords = rawData.words.filter(validateDetectedWord);

    if (validWords.length === 0) {
      logger.error("DetectVocabulary: All entries failed validation");
      throw new HttpsError('internal', 'Vocabulary detection failed. Please try again.');
    }

    logger.info(`DetectVocabulary: Found ${validWords.length} interesting words`);

    return { words: validWords };
  } catch (error: any) {
    if (error instanceof HttpsError) throw error;

    const msg = error.message || 'Detection failed';

    const isAbort = error.name === 'AbortError' || msg.includes('aborted');
    if (isAbort) {
      logger.error("DetectVocabulary: Timed out:", msg);
      throw new HttpsError('deadline-exceeded', 'The AI service is taking too long. Please try again with a shorter text.');
    }

    const isQuota =
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('RESOURCE_EXHAUSTED') ||
      error?.status === 429;

    if (isQuota) {
      throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
    }

    logger.error("DetectVocabulary failed:", msg);
    throw new HttpsError('internal', msg);
  }
});

// ============================================================================
// Analyze Input — Single word/phrase or sentence analysis
// ============================================================================

export const analyzeInput = onCall({ secrets: [deepinfraApiKey], cors: true, timeoutSeconds: 300 }, async (request) => {
  const deepinfraKey = deepinfraApiKey.value();
  
  if (!deepinfraKey) {
    throw new HttpsError('failed-precondition', 'DEEPINFRA_API_KEY not configured');
  }
  
  const text = request.data.text;
  if (!text) {
    throw new HttpsError('invalid-argument', 'The function must be called with one argument "text" containing the input text.');
  }

  // Track original query if input contains Chinese (for display purposes on client)
  const originalQuery = containsChinese(text) ? text : undefined;
  
  // ============================================================================
  // ANALYSIS — single LLM call handles both English and Chinese input
  // ============================================================================
  const isWord = isWordOrPhrase(text);
  logger.info(`Input "${text}" detected as: ${isWord ? 'WORD/PHRASE' : 'SENTENCE'}${originalQuery ? ' (Chinese input)' : ''}`);

  const userPrompt = isWord
    ? `Analyze this word or phrase for a C1 learner. Create vocabulary cards for ALL its meanings: "${text}"`
    : `Analyze this sentence for a C1 learner: "${text}"`;

  try {
    logger.info(`Analyzing with DeepSeek-V3 (${isWord ? 'word' : 'sentence'} mode)...`);
    const systemPrompt = isWord ? WORD_MODE_INSTRUCTION : SENTENCE_MODE_INSTRUCTION;
    const rawData = await callDeepSeek(deepinfraKey, systemPrompt, userPrompt);
    
    // Validate response structure before accepting
    const isValid = isWord 
      ? validateWordModeResponse(rawData)
      : validateSentenceModeResponse(rawData);
    
    if (!isValid) {
      logger.error("DeepSeek response failed validation");
      throw new HttpsError('internal', 'Analysis response validation failed');
    }
    
    logger.info("DeepSeek analysis succeeded and validated");

    // The model returns a `query` field with the English word/sentence it analyzed
    // This is especially important when input was Chinese
    const resolvedQuery = rawData.query || text;

    // Format response
    if (isWord) {
      return {
        translation: "", // Empty indicates word mode
        grammar: "",
        visualKeyword: rawData.vocabs?.[0]?.word || resolvedQuery,
        pronunciation: rawData.vocabs?.[0]?.ipa || "",
        vocabs: rawData.vocabs || [],
        originalQuery,
        query: resolvedQuery
      };
    } else {
      return {
        ...rawData,
        originalQuery,
        query: resolvedQuery
      };
    }
  } catch (error: any) {
    const msg = error.message || 'Analysis failed';
    
    // Detect timeout/abort errors
    const isAbort = error.name === 'AbortError' || msg.includes('aborted');
    if (isAbort) {
      logger.error("Analysis timed out after retries:", msg);
      throw new HttpsError('deadline-exceeded', 'The AI service is taking too long to respond. Please try again.');
    }
    
    const isQuota = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('RESOURCE_EXHAUSTED') || 
        error?.status === 429 || 
        error?.status === 'RESOURCE_EXHAUSTED';

    if (isQuota) {
      throw new HttpsError('resource-exhausted', "QUOTA_EXCEEDED");
    }
    
    logger.error("Analysis failed:", msg);
    throw new HttpsError('internal', msg);
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

// ============================================================================
// Speech-to-Text with Whisper Large V3 Turbo (DeepInfra)
// ============================================================================

export const transcribeAudio = onCall({ secrets: [deepinfraApiKey], cors: true }, async (request) => {
  const deepinfraKey = deepinfraApiKey.value();
  
  if (!deepinfraKey) {
    throw new HttpsError('failed-precondition', 'DEEPINFRA_API_KEY not configured');
  }
  
  const audioData = request.data.audio; // Base64 encoded audio
  const mimeType = request.data.mimeType || 'audio/webm';
  
  if (!audioData) {
    throw new HttpsError('invalid-argument', 'The function must be called with "audio" containing base64 encoded audio data.');
  }

  try {
    logger.info("Transcribing audio with Whisper Large V3 Turbo...");
    
    // Convert base64 to binary
    const audioBuffer = Buffer.from(audioData, 'base64');
    
    // Create form data for the API
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('audio', blob, `audio.${mimeType.split('/')[1] || 'webm'}`);
    
    const response = await fetchWithTimeout(
      'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepinfraKey}`,
        },
        body: formData,
      },
      30000 // 30 second timeout
    );

    if (!response.ok) {
      const status = response.status;
      const errorData = await response.json().catch(() => ({}));
      logger.warn("Whisper API error:", status, errorData);
      
      if (status === 429 || status === 402) {
        throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
      }
      
      throw new Error(`Whisper API error: ${status}`);
    }

    const data = await response.json();
    const transcribedText = data.text?.trim() || '';
    
    logger.info(`Transcription successful: "${transcribedText.substring(0, 50)}..."`);
    
    return { text: transcribedText };
  } catch (error: any) {
    const msg = error.message || 'Transcription failed';
    logger.error("Transcription failed:", msg);
    
    if (error.code) {
      throw error; // Re-throw HttpsError as-is
    }
    
    throw new HttpsError('internal', msg);
  }
});

export const generateIllustration = onCall({ secrets: [deepinfraApiKey, replicateApiKey], cors: true }, async (request) => {
  const prompt = request.data.prompt;
  const aspectRatio = request.data.aspectRatio || '1:1';

  if (!prompt) {
    throw new HttpsError('invalid-argument', 'Prompt is required');
  }

  const styledPrompt = `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.`;
  const dimensions = getImageDimensions(aspectRatio);
  
  logger.info(`Generating image with aspect ratio: ${aspectRatio} (${dimensions.width}x${dimensions.height})`);

  // Try DeepInfra FLUX Schnell (primary)
  const deepinfraKey = deepinfraApiKey.value();
  if (deepinfraKey) {
    try {
      logger.info("Generating with DeepInfra FLUX Schnell...");
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
          logger.info("DeepInfra FLUX succeeded");
          return { imageData };
        }
      } else {
        const status = response.status;
        const errorData = await response.json().catch(() => ({}));
        logger.warn("DeepInfra FLUX failed:", status, errorData);
        
        // Check for quota issues
        if (status == 429 || status == 402) {
          logger.warn("DeepInfra quota exceeded");
          return { imageData: undefined, error: "QUOTA_EXCEEDED" };
        }
      }
    } catch (deepinfraError: any) {
      logger.warn("DeepInfra FLUX error:", deepinfraError.message);
    }
  } else {
    logger.warn("DEEPINFRA_API_KEY not set");
  }

  // Fallback to Replicate FLUX Schnell
  const replicateKey = replicateApiKey.value();
  if (!replicateKey) {
    logger.error("No image generation API keys available");
    return { imageData: undefined, error: "NO_API_KEY" };
  }

  try {
    logger.info("Trying Replicate FLUX Schnell (fallback)...");
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
      
      logger.info("Replicate FLUX succeeded");
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

// ============================================================================
// Podcast Generation — GPT-4o Script + OpenAI TTS
// ============================================================================

interface PodcastWord {
  word: string;
  chinese: string;
  sense: string;
  definition?: string;
  example?: string;
  mnemonic?: string;
  memoryStrength?: number; // 0-100, lower = weaker
}

interface PodcastMetadata {
  id: string;
  generatedAt: number;
  mode: 'daily' | 'manual';
  status: 'generating' | 'ready' | 'failed';
  audioPath: string;
  duration: number;
  wordCount: number;
  words: { word: string; chinese: string; sense: string }[];
  script: string;
}

// --- Prompt templates ---

const PODCAST_SCRIPT_PROMPT_DAILY = `You are the host of "Word Power Daily", a warm and engaging English vocabulary podcast for Chinese-speaking learners at the C1/C2 level.

Write a complete podcast episode script of approximately 4000 words (20 minutes when read aloud).

FORMAT — LAYERED REPETITION:
The episode uses a wave-based structure that repeats words multiple times for memorization. Follow this structure exactly:

  Wave 1 — Introduce words 1 through 6:
    For each word: say it clearly, spell it out, explain the definition in plain English, paint a vivid scenario or example, and share the memory trick.
    Spend about 80 to 100 words per word.

  Review 1 — Quick recap of words 1 through 6:
    Rapid fire: say the word, one-sentence meaning. About 60 words total.
    Make it feel like a fun quiz ("Alright, let's see how many you remember...")

  Wave 2 — Introduce words 7 through 12:
    Same depth as Wave 1.

  Review 2 — Recap of ALL words covered so far (1 through 12):
    Rapid fire recap. About 120 words total.

  Wave 3 — Introduce words 13 through 18:
    Same depth as Wave 1.

  Review 3 — Recap of ALL words so far (1 through 18):
    Rapid fire recap. About 180 words total.

  Wave 4 — Introduce words 19 through 24:
    Same depth as Wave 1.

  Review 4 — Recap of ALL words so far (1 through 24):
    Rapid fire recap. About 240 words total.

  Wave 5 — Introduce words 25 through 30:
    Same depth as Wave 1.

  Final Review — ALL 30 words:
    Go through all 30 one more time. For each: say the word and a one-sentence meaning. About 350 words total.
    End with a warm sign-off.

VOICE AND TONE:
- Speak naturally, like a knowledgeable friend
- Be warm, encouraging, and occasionally witty
- Vary transitions between waves
- During reviews, keep energy up — make it feel like a fun quiz, not a chore
- During introductions, take your time — be vivid and memorable

ADAPTIVE DIFFICULTY:
Each word includes a Memory Strength percentage (0-100%). Lower values mean the learner struggles more with this word.
- Words below 30%: Spend extra time, give more vivid examples, repeat more often in reviews
- Words 30-60%: Normal coverage
- Words above 60%: Can be slightly briefer during introduction, but still include in all reviews

CRITICAL RULES:
- Do NOT include any Chinese characters, Chinese words, or pinyin anywhere in the script. This is an English-only audio podcast. The Chinese translations are displayed separately on screen.
- No markdown, no bullet points, no asterisks, no special formatting of any kind
- No stage directions like [pause] or (laughs)
- Write pure spoken prose — every single word will be read aloud exactly as written
- The script MUST be between 3800 and 4200 words. This is critical for timing.`;

const PODCAST_SCRIPT_PROMPT_MANUAL = `You are the host of "Word Power Daily", a warm and engaging English vocabulary podcast for Chinese-speaking learners at the C1/C2 level.

Write a focused deep-dive podcast episode script of approximately 800 to 1200 words (5-7 minutes when read aloud).

FORMAT — DEEP CONVERSATIONAL DIVE:
Since there are only a few words, go deep on each one:

For each word:
- Say it clearly, spell it out
- Give a thorough English definition
- Explain the etymology and how the meaning evolved
- Provide 2-3 vivid example scenarios showing different contexts
- Share common mistakes learners make with this word
- Mention related words and how they differ
- Give a memorable mnemonic or memory trick
- End with a quick recap sentence

VOICE AND TONE:
- Speak naturally, like a knowledgeable friend
- Be warm, encouraging, and occasionally witty
- Take your time — this is a focused session

ADAPTIVE DIFFICULTY:
Each word includes a Memory Strength percentage (0-100%). Lower values mean the learner struggles more with this word.
Spend proportionally more time, more examples, and more repetitions on weaker words.

CRITICAL RULES:
- Do NOT include any Chinese characters, Chinese words, or pinyin anywhere in the script. This is an English-only audio podcast. The Chinese translations are displayed separately on screen.
- No markdown, no bullet points, no asterisks, no special formatting of any kind
- No stage directions like [pause] or (laughs)
- Write pure spoken prose — every single word will be read aloud exactly as written`;

// --- GPT-4o Script Generation ---

async function callGPT4o(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  logger.info("Podcast: Calling GPT-4o for script generation...");

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 16384,
      }),
    },
    300000 // 5 minute timeout
  );

  if (!response.ok) {
    const status = response.status;
    const errorData = await response.json().catch(() => ({}));
    logger.error("GPT-4o API error:", status, JSON.stringify(errorData));
    throw new Error(`GPT-4o API error: ${status}`);
  }

  const data = await response.json();
  const script = data.choices?.[0]?.message?.content;
  if (!script) {
    throw new Error("GPT-4o returned empty response");
  }

  // Clean any markdown that leaked through
  const clean = script
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '');

  const wordCount = clean.split(/\s+/).length;
  logger.info(`Podcast: Script generated (${wordCount} words)`);
  return clean;
}

// --- OpenAI TTS ---

function splitIntoParagraphChunks(text: string, maxChars: number = 4096): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let sentChunk = '';
      for (const sent of sentences) {
        if ((sentChunk + ' ' + sent).length > maxChars && sentChunk.trim()) {
          chunks.push(sentChunk.trim());
          sentChunk = sent;
        } else {
          sentChunk += (sentChunk ? ' ' : '') + sent;
        }
      }
      if (sentChunk.trim()) {
        current = sentChunk;
      }
      continue;
    }

    if ((current + '\n\n' + para).length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

async function callOpenAITTS(apiKey: string, text: string): Promise<Buffer> {
  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        input: text,
        voice: 'nova',
        response_format: 'mp3',
      }),
    },
    120000 // 2 minute timeout per chunk
  );

  if (!response.ok) {
    const status = response.status;
    const errorData = await response.text().catch(() => '');
    logger.error("OpenAI TTS error:", status, errorData);
    throw new Error(`OpenAI TTS error: ${status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function generatePodcastAudio(apiKey: string, script: string): Promise<Buffer> {
  logger.info(`Podcast: Generating audio (${script.length} chars)...`);

  const MAX_CHARS = 4096;

  if (script.length <= MAX_CHARS) {
    return await callOpenAITTS(apiKey, script);
  }

  const chunks = splitIntoParagraphChunks(script, MAX_CHARS);
  logger.info(`Podcast: Splitting into ${chunks.length} TTS chunks...`);

  const audioBuffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logger.info(`Podcast: TTS chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    const buffer = await callOpenAITTS(apiKey, chunks[i]);
    audioBuffers.push(buffer);
    logger.info(`Podcast: TTS chunk ${i + 1} done (${(buffer.length / 1024).toFixed(0)} KB)`);
  }

  const combined = Buffer.concat(audioBuffers);
  logger.info(`Podcast: Audio complete (${(combined.length / 1024 / 1024).toFixed(1)} MB)`);
  return combined;
}

// --- Retry wrapper for podcast generation ---

function isTransientError(error: any): boolean {
  const msg = (error.message || '').toLowerCase();
  return (
    error.name === 'AbortError' ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('api error: 5') || // 5xx
    msg.includes('api error: 429') ||
    msg.includes('rate limit') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound')
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  label: string = 'operation'
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`${label}: attempt ${attempt}/${maxAttempts}`);
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxAttempts && isTransientError(error)) {
        const backoffMs = attempt * 3000;
        logger.warn(`${label}: attempt ${attempt} failed (${error.message}), retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      // Non-retryable error or final attempt
      break;
    }
  }
  throw lastError;
}

// --- Core generation function (runs in background trigger) ---

async function generatePodcastCore(
  apiKey: string,
  words: PodcastWord[],
  userId: string,
  podcastId: string,
  mode: 'daily' | 'manual'
): Promise<void> {
  const docRef = adminDb.doc(`users/${userId}/podcasts/${podcastId}`);

  try {
    // 1. Generate script
    const isDaily = mode === 'daily' || words.length > 3;
    const systemPrompt = isDaily ? PODCAST_SCRIPT_PROMPT_DAILY : PODCAST_SCRIPT_PROMPT_MANUAL;

    const wordList = words
      .map((w, i) => {
        const strength = w.memoryStrength !== undefined ? w.memoryStrength : -1;
        const strengthLine = strength >= 0
          ? `\nMemory Strength: ${Math.round(strength)}%${strength < 30 ? ' (very weak — spend extra time here)' : strength < 60 ? ' (moderate)' : ' (stronger)'}`
          : '';
        return `Word ${i + 1}: ${w.word}\nSense: ${w.sense}\nDefinition: ${w.definition || 'N/A'}\nExample: ${w.example || 'N/A'}\nMnemonic: ${w.mnemonic || 'N/A'}${strengthLine}`;
      })
      .join('\n\n');

    const userPrompt = isDaily
      ? `Here are today's ${words.length} vocabulary words. Write the complete podcast episode following the layered repetition structure in your instructions:\n\n${wordList}`
      : `Here are ${words.length} vocabulary word${words.length > 1 ? 's' : ''} for a focused deep-dive episode:\n\n${wordList}`;

    const script = await callGPT4o(apiKey, systemPrompt, userPrompt);

    // 2. Generate audio
    const audioBuffer = await generatePodcastAudio(apiKey, script);

    // 3. Upload audio to Firebase Storage
    const audioPath = `podcasts/${userId}/${podcastId}.mp3`;
    const bucket = adminStorage.bucket();
    const file = bucket.file(audioPath);
    await file.save(audioBuffer, {
      metadata: {
        contentType: 'audio/mpeg',
        metadata: {
          podcastId,
          userId,
          mode,
          generatedAt: Date.now().toString(),
        }
      }
    });
    logger.info(`Podcast: Audio uploaded to ${audioPath} (${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

    // 4. Estimate duration (~150 words per minute for TTS)
    const scriptWordCount = script.split(/\s+/).length;
    const estimatedDuration = Math.round((scriptWordCount / 150) * 60);

    // 5. Update metadata to 'ready'
    await docRef.update({
      status: 'ready',
      audioPath,
      duration: estimatedDuration,
      script,
    });
    logger.info(`Podcast: Generation complete for ${podcastId}`);

  } catch (error: any) {
    logger.error(`Podcast: Generation failed for ${podcastId}:`, error.message);
    // Update status to 'failed' so the UI knows
    await docRef.update({
      status: 'failed',
    }).catch(e => logger.error("Failed to update status to failed:", e));
    throw error; // Re-throw for retry logic
  }
}

// --- Word selection for daily mode ---

async function selectWeakestWords(userId: string, count: number = 30): Promise<PodcastWord[]> {
  const itemsSnapshot = await adminDb.collection(`users/${userId}/items`).get();

  const vocabItems: any[] = [];
  itemsSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.isDeleted || data.isArchived) return;
    if (data.type !== 'vocab') return;
    if (!data.data || !data.srs) return;
    vocabItems.push(data);
  });

  if (vocabItems.length === 0) {
    throw new HttpsError('failed-precondition', 'No vocabulary items found. Add some words to your notebook first.');
  }

  // Sort by memoryStrength ASC (weakest first)
  vocabItems.sort((a, b) => {
    const strengthA = a.srs?.memoryStrength ?? 100;
    const strengthB = b.srs?.memoryStrength ?? 100;
    return strengthA - strengthB;
  });

  // Take top N
  const selected = vocabItems.slice(0, count);

  return selected.map(item => ({
    word: item.data.word || '',
    chinese: item.data.chinese || '',
    sense: item.data.sense || '',
    definition: item.data.definition || '',
    example: item.data.examples?.[0] || '',
    mnemonic: item.data.mnemonic || '',
    memoryStrength: item.srs?.memoryStrength ?? 100,
  }));
}

// --- Callable function: generatePodcast (async — returns immediately) ---

export const generatePodcast = onCall({
  cors: true,
  timeoutSeconds: 60,
}, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const wordIds: string[] | undefined = request.data.wordIds;
  let words: PodcastWord[];
  let mode: 'daily' | 'manual';

  if (wordIds && Array.isArray(wordIds) && wordIds.length > 0) {
    if (wordIds.length > 30) {
      throw new HttpsError('invalid-argument', 'Maximum 30 words for manual podcast');
    }

    mode = wordIds.length <= 3 ? 'manual' : 'daily';
    words = [];

    for (const wordId of wordIds) {
      const docSnap = await adminDb.doc(`users/${userId}/items/${wordId}`).get();
      if (!docSnap.exists) {
        throw new HttpsError('not-found', `Item ${wordId} not found`);
      }
      const data = docSnap.data() as any;
      words.push({
        word: data.data?.word || '',
        chinese: data.data?.chinese || '',
        sense: data.data?.sense || '',
        definition: data.data?.definition || '',
        example: data.data?.examples?.[0] || '',
        mnemonic: data.data?.mnemonic || '',
        memoryStrength: data.srs?.memoryStrength ?? 100,
      });
    }
  } else {
    // Auto mode: select 30 weakest words
    mode = 'daily';
    words = await selectWeakestWords(userId, 30);
  }

  // Create podcast document with status: 'generating' and return immediately
  const podcastId = `podcast_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const metadata: PodcastMetadata = {
    id: podcastId,
    generatedAt: Date.now(),
    mode,
    status: 'generating',
    audioPath: '',
    duration: 0,
    wordCount: words.length,
    words: words.map(w => ({ word: w.word, chinese: w.chinese, sense: w.sense })),
    script: '',
  };

  // Store full word data in a separate field for the trigger to use
  const docData = {
    ...metadata,
    _wordsForGeneration: words, // Internal field consumed by the trigger
  };

  await adminDb.doc(`users/${userId}/podcasts/${podcastId}`).set(docData);
  logger.info(`Podcast: Created ${podcastId} with status 'generating' for user ${userId} (${words.length} words)`);

  // Return immediately — the Firestore trigger will handle the rest
  return { id: podcastId, status: 'generating' };
});

// --- Firestore trigger: processPodcast (does the actual generation) ---

export const processPodcast = onDocumentCreated({
  document: "users/{userId}/podcasts/{podcastId}",
  secrets: [openaiApiKey],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;

  const data = snapshot.data();
  if (data.status !== 'generating') {
    logger.info(`processPodcast: Skipping ${event.params.podcastId} (status: ${data.status})`);
    return;
  }

  const apiKey = openaiApiKey.value();
  if (!apiKey) {
    logger.error("processPodcast: OPENAI_API_KEY not configured");
    await snapshot.ref.update({ status: 'failed' });
    return;
  }

  const userId = event.params.userId;
  const podcastId = event.params.podcastId;
  const words: PodcastWord[] = data._wordsForGeneration || [];
  const mode = data.mode || 'daily';

  if (words.length === 0) {
    logger.error(`processPodcast: No words found in doc ${podcastId}`);
    await snapshot.ref.update({ status: 'failed' });
    return;
  }

  logger.info(`processPodcast: Starting generation for ${podcastId} (${words.length} words, mode: ${mode})`);

  await withRetry(
    () => generatePodcastCore(apiKey, words, userId, podcastId, mode),
    3,
    `processPodcast[${podcastId}]`
  );

  // Clean up the internal field after successful generation
  await snapshot.ref.update({
    _wordsForGeneration: admin.firestore.FieldValue.delete(),
  });
});

// --- Callable function: deletePodcast ---

export const deletePodcast = onCall({
  cors: true,
  timeoutSeconds: 30,
}, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const podcastId: string = request.data.podcastId;
  if (!podcastId) {
    throw new HttpsError('invalid-argument', 'podcastId is required');
  }

  const docRef = adminDb.doc(`users/${userId}/podcasts/${podcastId}`);
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    throw new HttpsError('not-found', 'Podcast not found');
  }

  const data = docSnap.data();

  // Delete audio file from Storage if it exists
  if (data?.audioPath) {
    try {
      const bucket = adminStorage.bucket();
      const file = bucket.file(data.audioPath);
      await file.delete();
      logger.info(`deletePodcast: Deleted audio file ${data.audioPath}`);
    } catch (e: any) {
      // File might not exist (e.g., failed generation) — that's OK
      logger.warn(`deletePodcast: Could not delete audio file: ${e.message}`);
    }
  }

  // Delete the Firestore document
  await docRef.delete();
  logger.info(`deletePodcast: Deleted podcast ${podcastId} for user ${userId}`);

  return { success: true };
});

// --- Callable function: retryPodcast ---

export const retryPodcast = onCall({
  cors: true,
  timeoutSeconds: 30,
}, async (request) => {
  const userId = request.auth?.uid;
  if (!userId) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const podcastId: string = request.data.podcastId;
  if (!podcastId) {
    throw new HttpsError('invalid-argument', 'podcastId is required');
  }

  const docRef = adminDb.doc(`users/${userId}/podcasts/${podcastId}`);
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    throw new HttpsError('not-found', 'Podcast not found');
  }

  const data = docSnap.data();
  if (data?.status !== 'failed') {
    throw new HttpsError('failed-precondition', 'Can only retry failed podcasts');
  }

  // Reconstruct _wordsForGeneration from the stored words metadata
  const wordsForGen: PodcastWord[] = (data.words || []).map((w: any) => ({
    word: w.word || '',
    chinese: w.chinese || '',
    sense: w.sense || '',
    definition: w.definition || '',
    example: w.example || '',
    mnemonic: w.mnemonic || '',
    memoryStrength: w.memoryStrength,
  }));

  if (wordsForGen.length === 0) {
    throw new HttpsError('failed-precondition', 'No words found in podcast to retry');
  }

  // Delete the old failed doc, then re-create to trigger onDocumentCreated
  await docRef.delete();

  const newDocData = {
    id: podcastId,
    generatedAt: Date.now(),
    mode: data.mode || 'manual',
    status: 'generating',
    audioPath: '',
    duration: 0,
    wordCount: wordsForGen.length,
    words: wordsForGen.map(w => ({ word: w.word, chinese: w.chinese, sense: w.sense })),
    script: '',
    _wordsForGeneration: wordsForGen,
  };

  await docRef.set(newDocData);
  logger.info(`retryPodcast: Re-created podcast ${podcastId} for user ${userId} (trigger will process)`);

  return { success: true };
});

// --- Scheduled function: dailyPodcastJob ---

export const dailyPodcastJob = onSchedule({
  schedule: "every day 14:00",
  timeZone: "UTC",
  secrets: [openaiApiKey],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async () => {
  const apiKey = openaiApiKey.value();
  if (!apiKey) {
    logger.error("dailyPodcastJob: OPENAI_API_KEY not configured, skipping");
    return;
  }

  logger.info("dailyPodcastJob: Starting daily podcast generation...");

  // Find all users who have items
  const usersSnapshot = await adminDb.collection('users').listDocuments();

  for (const userDoc of usersSnapshot) {
    const userId = userDoc.id;
    logger.info(`dailyPodcastJob: Processing user ${userId}...`);

    try {
      const words = await selectWeakestWords(userId, 30);
      if (words.length === 0) {
        logger.info(`dailyPodcastJob: User ${userId} has no vocab items, skipping`);
        continue;
      }

      // Create a 'generating' doc — the Firestore trigger will pick it up
      const podcastId = `podcast_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      await adminDb.doc(`users/${userId}/podcasts/${podcastId}`).set({
        id: podcastId,
        generatedAt: Date.now(),
        mode: 'daily',
        status: 'generating',
        audioPath: '',
        duration: 0,
        wordCount: words.length,
        words: words.map(w => ({ word: w.word, chinese: w.chinese, sense: w.sense })),
        script: '',
        _wordsForGeneration: words,
      });

      logger.info(`dailyPodcastJob: Created podcast ${podcastId} for user ${userId} (trigger will process)`);
    } catch (error: any) {
      logger.error(`dailyPodcastJob: Failed for user ${userId}:`, error.message);
    }
  }

  logger.info("dailyPodcastJob: Completed (triggers will handle generation)");
});
