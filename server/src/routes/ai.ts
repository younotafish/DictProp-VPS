import { Hono } from 'hono';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';

export const aiRoutes = new Hono();

// ============================================================================
// DeepSeek-V3 Helper (Text model via DeepInfra)
// ============================================================================

const DEEPSEEK_TIMEOUT_MS = 100000;
const DEEPINFRA_CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const DEEPINFRA_WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo';
const DEEPSEEK_MODEL = 'deepseek-ai/DeepSeek-V3';
const DEFAULT_TEMPERATURE = 0.7;

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await proxyFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callDeepSeekOnce(apiKey: string, systemPrompt: string, userPrompt: string): Promise<any> {
  console.log(`DeepSeek: calling API (timeout ${DEEPSEEK_TIMEOUT_MS}ms)`);

  const response = await fetchWithTimeout(
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

  if (!response.ok) {
    const status = response.status;
    const errorData = await response.json().catch(() => ({}));
    console.warn('DeepSeek API error:', status, JSON.stringify(errorData));
    throw new Error(`DeepSeek API error: ${status}`);
  }

  const data: any = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned empty response');

  let jsonStr = content.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
    throw new Error('Failed to parse JSON from DeepSeek response');
  }
}

async function callDeepSeek(apiKey: string, systemPrompt: string, userPrompt: string, maxRetries = 1): Promise<any> {
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
        msg.includes('DeepSeek API error: 5') ||
        msg.includes('DeepSeek API error: 429') ||
        msg.includes('fetch failed');

      if (attempt < maxRetries && isRetryable) {
        console.warn(`DeepSeek attempt ${attempt + 1} failed (${msg}), retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    }
  }
  throw lastError;
}

// ============================================================================
// Validation
// ============================================================================

function validateVocabCard(vocab: any): boolean {
  if (!vocab || typeof vocab !== 'object') return false;
  for (const f of ['word', 'sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt']) {
    if (typeof vocab[f] !== 'string') return false;
  }
  for (const f of ['forms', 'synonyms', 'antonyms', 'confusables', 'examples']) {
    if (!Array.isArray(vocab[f])) return false;
  }
  return true;
}

function validateWordModeResponse(data: any): boolean {
  if (!data || !Array.isArray(data.vocabs) || data.vocabs.length === 0) return false;
  return validateVocabCard(data.vocabs[0]);
}

function validateSentenceModeResponse(data: any): boolean {
  if (!data) return false;
  for (const f of ['translation', 'grammar', 'visualKeyword', 'pronunciation']) {
    if (typeof data[f] !== 'string') return false;
  }
  if (!Array.isArray(data.vocabs)) return false;
  if (data.vocabs.length > 0 && !validateVocabCard(data.vocabs[0])) return false;
  return true;
}

function validateDetectedWord(word: any): boolean {
  if (!word || typeof word !== 'object') return false;
  return (
    typeof word.word === 'string' && word.word.trim().length > 0 &&
    typeof word.context === 'string' &&
    typeof word.level === 'string' &&
    typeof word.reason === 'string'
  );
}

// ============================================================================
// Prompts (copied from Cloud Functions)
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

// ============================================================================
// Helper functions
// ============================================================================

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function isWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();

  if (containsChinese(trimmed)) {
    if (/[。！？]$/.test(trimmed)) return false;
    const chineseChars = trimmed.match(/[\u4e00-\u9fff]/g) || [];
    if (chineseChars.length >= 5) return false;
    return true;
  }

  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 1) return true;
  if (/[.!?]$/.test(trimmed)) return false;
  if (words.length >= 6) return false;

  const startsLikeSentence = /^(I|You|He|She|It|We|They|The|A|An|This|That|There|Here)\s/i.test(trimmed);
  const hasAuxVerb = /\b(is|are|was|were|have|has|had|do|does|did|will|would|could|should|can|may|might)\b/i.test(trimmed);
  if (startsLikeSentence || hasAuxVerb) return false;

  return true;
}

function errorResponse(msg: string, status: number) {
  return { error: msg, status };
}

// ============================================================================
// Routes
// ============================================================================

// POST /api/analyze — analyze a word/phrase/sentence
aiRoutes.post('/analyze', async (c) => {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

  const { text } = await c.req.json();
  if (!text || typeof text !== 'string') {
    return c.json(errorResponse('Missing "text" field', 400), 400);
  }

  const originalQuery = containsChinese(text) ? text : undefined;
  const isWord = isWordOrPhrase(text);
  console.log(`Input "${text}" detected as: ${isWord ? 'WORD/PHRASE' : 'SENTENCE'}${originalQuery ? ' (Chinese)' : ''}`);

  const userPrompt = isWord
    ? `Analyze this word or phrase for a C1 learner. Create vocabulary cards for ALL its meanings: "${text}"`
    : `Analyze this sentence for a C1 learner: "${text}"`;

  try {
    const systemPrompt = isWord ? WORD_MODE_INSTRUCTION : SENTENCE_MODE_INSTRUCTION;
    const rawData = await callDeepSeek(apiKey, systemPrompt, userPrompt);

    const isValid = isWord ? validateWordModeResponse(rawData) : validateSentenceModeResponse(rawData);
    if (!isValid) return c.json(errorResponse('Analysis response validation failed', 500), 500);

    const resolvedQuery = rawData.query || text;

    if (isWord) {
      return c.json({
        translation: '',
        grammar: '',
        visualKeyword: rawData.vocabs?.[0]?.word || resolvedQuery,
        pronunciation: rawData.vocabs?.[0]?.ipa || '',
        vocabs: rawData.vocabs || [],
        originalQuery,
        query: resolvedQuery,
      });
    } else {
      return c.json({ ...rawData, originalQuery, query: resolvedQuery });
    }
  } catch (error: any) {
    const msg = error.message || 'Analysis failed';
    if (error.name === 'AbortError' || msg.includes('aborted')) {
      return c.json(errorResponse('The AI service timed out. Please try again.', 504), 504);
    }
    if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
      return c.json(errorResponse('QUOTA_EXCEEDED', 429), 429);
    }
    console.error('Analysis failed:', msg);
    return c.json(errorResponse(msg, 500), 500);
  }
});

// POST /api/extract-vocabulary — detect interesting words in text
aiRoutes.post('/extract-vocabulary', async (c) => {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

  const { text } = await c.req.json();
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return c.json(errorResponse('Please provide a text passage of at least 10 characters.', 400), 400);
  }

  const maxChars = 5000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
  const userPrompt = `Scan this text and identify all rare, advanced, or interesting vocabulary worth studying:\n\n"${truncatedText}"`;

  try {
    const rawData = await callDeepSeek(apiKey, TEXT_DETECT_INSTRUCTION, userPrompt);
    if (!rawData || !Array.isArray(rawData.words) || rawData.words.length === 0) {
      return c.json(errorResponse('No interesting vocabulary found in the text.', 404), 404);
    }
    const validWords = rawData.words.filter(validateDetectedWord);
    if (validWords.length === 0) {
      return c.json(errorResponse('Vocabulary detection failed. Please try again.', 500), 500);
    }
    return c.json({ words: validWords });
  } catch (error: any) {
    const msg = error.message || 'Detection failed';
    if (error.name === 'AbortError' || msg.includes('aborted')) {
      return c.json(errorResponse('Timed out. Try a shorter text.', 504), 504);
    }
    if (msg.includes('429') || msg.includes('quota')) {
      return c.json(errorResponse('QUOTA_EXCEEDED', 429), 429);
    }
    console.error('Vocabulary detection failed:', msg);
    return c.json(errorResponse(msg, 500), 500);
  }
});

// POST /api/compare — compare 2-3 words
aiRoutes.post('/compare', async (c) => {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

  const { words } = await c.req.json();
  if (!words || !Array.isArray(words) || words.length < 2 || words.length > 3) {
    return c.json(errorResponse('Please provide 2-3 words to compare.', 400), 400);
  }

  const cleanWords = words.map((w: any) => (typeof w === 'string' ? w.trim() : '')).filter((w: string) => w.length > 0);
  if (cleanWords.length < 2) {
    return c.json(errorResponse('Please provide at least 2 valid words.', 400), 400);
  }

  const userPrompt = `Compare these words: ${cleanWords.join(', ')}`;

  try {
    const rawData = await callDeepSeek(apiKey, COMPARE_WORDS_INSTRUCTION, userPrompt);
    if (!rawData || !Array.isArray(rawData.dimensions) || rawData.dimensions.length === 0) {
      return c.json(errorResponse('Comparison failed. Please try again.', 500), 500);
    }

    return c.json({
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
    });
  } catch (error: any) {
    const msg = error.message || 'Comparison failed';
    if (error.name === 'AbortError' || msg.includes('aborted')) {
      return c.json(errorResponse('Timed out. Please try again.', 504), 504);
    }
    if (msg.includes('429') || msg.includes('quota')) {
      return c.json(errorResponse('QUOTA_EXCEEDED', 429), 429);
    }
    console.error('Comparison failed:', msg);
    return c.json(errorResponse(msg, 500), 500);
  }
});

// POST /api/transcribe — speech-to-text with Whisper
aiRoutes.post('/transcribe', async (c) => {
  const apiKey = env.DEEPINFRA_API_KEY;
  if (!apiKey) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

  const { audio, mimeType = 'audio/webm' } = await c.req.json();
  if (!audio) {
    return c.json(errorResponse('Missing "audio" base64 data.', 400), 400);
  }

  try {
    const audioBuffer = Buffer.from(audio, 'base64');
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('audio', blob, `audio.${mimeType.split('/')[1] || 'webm'}`);

    const response = await fetchWithTimeout(
      DEEPINFRA_WHISPER_URL,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
      },
      30000
    );

    if (!response.ok) {
      const status = response.status;
      if (status === 429 || status === 402) {
        return c.json(errorResponse('QUOTA_EXCEEDED', 429), 429);
      }
      return c.json(errorResponse(`Whisper API error: ${status}`, 500), 500);
    }

    const data: any = await response.json();
    return c.json({ text: data.text?.trim() || '' });
  } catch (error: any) {
    console.error('Transcription failed:', error.message);
    return c.json(errorResponse(error.message || 'Transcription failed', 500), 500);
  }
});
