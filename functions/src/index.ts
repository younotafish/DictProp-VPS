import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Define the secret parameters
const replicateApiKey = defineSecret("REPLICATE_API_TOKEN");
const deepinfraApiKey = defineSecret("DEEPINFRA_API_KEY");

// ============================================================================
// DeepSeek-V3 Helper (Text model via DeepInfra)
// ============================================================================

const DEEPSEEK_TIMEOUT_MS = 100000; // 100 second timeout

// API endpoints and model identifiers
const DEEPINFRA_CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const DEEPINFRA_WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo';
const DEEPINFRA_FLUX_URL = 'https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell';
const REPLICATE_FLUX_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const DEEPSEEK_MODEL = 'deepseek-ai/DeepSeek-V3';
const DEFAULT_TEMPERATURE = 0.7;

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
      DEEPINFRA_CHAT_URL,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: DEFAULT_TEMPERATURE,
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
  "ipa": "string - General American (GA) IPA with stress marks. Use Merriam-Webster pronunciation as reference, NEVER Oxford/Cambridge. MUST be rhotic American, NEVER British RP. Use American stress patterns (e.g., vaginal=/ˈvædʒənəl/ NOT British /vəˈdʒaɪnəl/, address(n)=/ˈædrɛs/ NOT /əˈdrɛs/, garage=/ɡəˈrɑːʒ/ NOT /ˈɡærɑːʒ/). Key rules: always include /r/ after vowels (car=/kɑːr/ NOT /kɑː/), use /ɑː/ not /ɒ/ (lot=/lɑːt/ NOT /lɒt/), use /æ/ not /ɑː/ in BATH words (bath=/bæθ/ NOT /bɑːθ/), use /ɛr/ not /eə/ (care=/kɛr/ NOT /keə/), use /t/ not /ʔ/ (better=/ˈbɛtɚ/ NOT /ˈbeʔə/), use /ɚ/ or /ər/ for unstressed -er (never silent r)",
  "definition": "string - Original English definition for THIS specific meaning/sense",
  "forms": ["array of strings - Different grammatical forms (e.g., runs, running, ran)"],
  "wordFamily": ["array of objects - Related words of different parts of speech, each with { word, pos, chinese }"],
  "synonyms": ["array of strings - Synonyms for THIS specific meaning"],
  "antonyms": ["array of strings - Antonyms for THIS specific meaning"],
  "confusables": ["array of strings - Words easily confused with this (similar spelling, sound, or meaning)"],
  "examples": ["array of 2 strings - Natural contemporary sentences showing THIS specific meaning. Wrap any C1/C2 level words, idioms, or advanced phrases (other than the word being defined) in [[double brackets]] so they become clickable links. e.g. 'She managed to [[reconcile]] her personal beliefs with the [[prevailing]] social norms.'"],
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
  "pronunciation": "string - General American (GA) IPA of the full input. MUST be rhotic American, NEVER British RP. Always include /r/ after vowels, use /ɑː/ not /ɒ/, use /æ/ not /ɑː/ in BATH words, use /ɛr/ not /eə/",
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
// Compare Words — Side-by-side analysis of 2-3 similar words
// ============================================================================

const COMPARE_WORDS_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach specializing in vocabulary nuance.
The user will give you 2-3 English words that are similar in meaning.

Your task: Create a detailed, structured comparison that helps a Chinese-speaking learner understand EXACTLY when to use each word.

Analyze the words across these dimensions:
1. Core Meaning — What each word fundamentally means and how the meanings differ
2. Register & Formality — Is one more formal, literary, casual, or technical?
3. Collocations — What words commonly appear WITH each one? (e.g., "fleeting glance" but NOT "transient glance")
4. Connotation & Emotion — Does one carry positive, negative, or neutral weight?
5. Grammar & Usage — Are there syntactic differences? (e.g., one is used predicatively only)

Provide 2-3 contextual examples showing the SAME scenario but using each word, so the learner can see the difference in practice.

List common mistakes Chinese learners make when choosing between these words.

End with a clear, memorable verdict/rule of thumb.

You MUST respond with valid JSON in this exact format:
{
  "words": ["word1", "word2", "word3"],
  "summary": "string - One concise sentence capturing the KEY difference",
  "dimensions": [
    {
      "label": "string - Dimension name (e.g., 'Core Meaning')",
      "analysis": "string - 2-3 sentence overview comparing all words on this dimension",
      "perWord": {
        "word1": "string - How word1 relates to this dimension",
        "word2": "string - How word2 relates to this dimension",
        "word3": "string - How word3 relates to this dimension (omit key if only 2 words)"
      }
    }
  ],
  "examples": [
    {
      "context": "string - The scenario (e.g., 'Describing a brief moment of happiness')",
      "sentences": {
        "word1": "string - Natural sentence using word1",
        "word2": "string - Natural sentence using word2",
        "word3": "string - Natural sentence using word3 (omit key if only 2 words)"
      }
    }
  ],
  "commonMistakes": ["string - A specific mistake learners make and the correction"],
  "verdict": "string - A memorable rule of thumb (2-3 sentences) for choosing between these words"
}

IMPORTANT:
- Include 4-5 dimensions covering meaning, register, collocation, connotation, and grammar
- Include 2-3 contextual examples
- Include 2-4 common mistakes
- The verdict should be practical and memorable
- Use Chinese translations in parentheses where helpful for the Chinese-speaking learner
- Be specific and concrete, not vague`;

export const compareWords = onCall({ secrets: [deepinfraApiKey], cors: true, timeoutSeconds: 120 }, async (request) => {
  const deepinfraKey = deepinfraApiKey.value();

  if (!deepinfraKey) {
    throw new HttpsError('failed-precondition', 'DEEPINFRA_API_KEY not configured');
  }

  const words = request.data.words;
  if (!words || !Array.isArray(words) || words.length < 2 || words.length > 3) {
    throw new HttpsError('invalid-argument', 'Please provide 2-3 words to compare.');
  }

  // Validate each word is a non-empty string
  const cleanWords = words
    .map((w: any) => (typeof w === 'string' ? w.trim() : ''))
    .filter((w: string) => w.length > 0);

  if (cleanWords.length < 2) {
    throw new HttpsError('invalid-argument', 'Please provide at least 2 valid words to compare.');
  }

  const userPrompt = `Compare these words: ${cleanWords.join(', ')}`;

  try {
    logger.info(`CompareWords: Comparing [${cleanWords.join(', ')}]`);
    const rawData = await callDeepSeek(deepinfraKey, COMPARE_WORDS_INSTRUCTION, userPrompt);

    // Validate response structure
    if (!rawData || !Array.isArray(rawData.dimensions) || rawData.dimensions.length === 0) {
      logger.error("CompareWords: Invalid response structure");
      throw new HttpsError('internal', 'Comparison failed — invalid AI response. Please try again.');
    }

    // Ensure required fields exist with fallbacks
    const result = {
      words: Array.isArray(rawData.words) ? rawData.words : cleanWords,
      summary: typeof rawData.summary === 'string' ? rawData.summary : '',
      dimensions: rawData.dimensions.filter((d: any) =>
        d && typeof d.label === 'string' && typeof d.analysis === 'string' && d.perWord && typeof d.perWord === 'object'
      ),
      examples: Array.isArray(rawData.examples) ? rawData.examples.filter((e: any) =>
        e && typeof e.context === 'string' && e.sentences && typeof e.sentences === 'object'
      ) : [],
      commonMistakes: Array.isArray(rawData.commonMistakes) ? rawData.commonMistakes.filter((m: any) => typeof m === 'string') : [],
      verdict: typeof rawData.verdict === 'string' ? rawData.verdict : '',
    };

    logger.info(`CompareWords: Success — ${result.dimensions.length} dimensions, ${result.examples.length} examples`);
    return result;
  } catch (error: any) {
    if (error instanceof HttpsError) throw error;

    const msg = error.message || 'Comparison failed';

    const isAbort = error.name === 'AbortError' || msg.includes('aborted');
    if (isAbort) {
      logger.error("CompareWords: Timed out:", msg);
      throw new HttpsError('deadline-exceeded', 'The AI service is taking too long. Please try again.');
    }

    const isQuota =
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('RESOURCE_EXHAUSTED') ||
      error?.status === 429;

    if (isQuota) {
      throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
    }

    logger.error("CompareWords failed:", msg);
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
      DEEPINFRA_WHISPER_URL,
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
      const response = await fetch(DEEPINFRA_FLUX_URL, {
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
        if (status === 429 || status === 402) {
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
    const response = await fetch(REPLICATE_FLUX_URL, {
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
      
      if (status === 429 || status === 402) {
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

