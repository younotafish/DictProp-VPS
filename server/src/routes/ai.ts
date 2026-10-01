import { Hono } from 'hono';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import {
  AiError,
  aiErrorResponse,
  classifyAiError,
  createChatClient,
  createRequestContext,
  providerError,
  remainingMs,
  type AiErrorMessages,
  type AiRequestContext,
  type ChatJson,
  type FetchLike,
} from '../ai-client.js';
import {
  normalizeAnalysisResponse,
  normalizeVocabCard,
  sortVocabsByUsage,
  vocabValidationIssues,
} from '../ai-response.js';
import { isWordOrPhrase, MAX_COMPARE_WORDS } from '../query-mode.js';

// The JSON extractor lives with the chat client; re-exported for existing callers and tests.
export { parseModelJson } from '../ai-client.js';

// ============================================================================
// Budgets and limits
// ============================================================================

// DeepSeek-V4-Flash can take well over a minute to emit a full multi-sense vocab card set ("run down"
// alone yields 6 full cards, ~74s clean and more under VPS load). Each request gets ONE overall budget,
// shared by the first answer, targeted card repairs and a re-ask, and it ends early if the client
// disconnects. The client waits this long plus 30s (services/api.ts).
const ANALYSIS_BUDGET_MS = 300_000;
// Comparisons run in the background queue and get a larger budget than searches.
const COMPARE_BUDGET_MS = 600_000;
const EXTRACT_BUDGET_MS = 240_000;
const TRANSCRIBE_BUDGET_MS = 30_000;

const ANALYSIS_MAX_TOKENS = 16_000;
const REPAIR_MAX_TOKENS = 12_000;
const COMPARE_MAX_TOKENS = 8_000;
const EXTRACT_MAX_TOKENS = 8_000;
const REPAIR_TEMPERATURE = 0.3;

// A full answer is re-asked once at most (after a cut-off reply or when nothing usable came back),
// and only while a whole generation can still fit in the budget.
const MAX_ANALYSIS_ATTEMPTS = 2;
const MIN_ANALYSIS_ATTEMPT_WINDOW_MS = 60_000;
// Failing cards get up to two targeted repair rounds; a repair rewrites only those cards, so it is shorter.
const MAX_REPAIR_ROUNDS = 2;
const MIN_REPAIR_WINDOW_MS = 20_000;

const MAX_EXTRACTED_WORDS = 12;
// A headword with more meanings gets its most useful ones: a longer answer is slow and risks being cut off.
const MAX_CARDS_PER_HEADWORD = 8;
const DEEPINFRA_WHISPER_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo';

// ============================================================================
// Prompts (copied from Cloud Functions)
// ============================================================================

const VOCAB_SCHEMA_DESCRIPTION = `
Each vocab object MUST have these fields:
{
  "word": "string - The vocabulary word or phrase",
  "sense": "string - Brief label for this specific meaning (e.g., 'noun: financial', 'verb: to rely on')",
  "chinese": "string - Chinese translation for THIS specific meaning only",
  "ipa": "string - EXACTLY ONE General American (GA) IPA transcription inside one pair of slashes, like /ˈbæŋk/. Never add a second pronunciation, alternates, region labels or square brackets; for a multi-word phrase put the whole phrase inside one pair of slashes (e.g., /rʌn ˈdaʊn/). Use Merriam-Webster pronunciation and stress as reference, NEVER Oxford/Cambridge, but write standard IPA symbols, never Merriam-Webster's own respelling (reckless=/ˈrɛkləs/ NOT ˈrek-ləs). MUST be rhotic American, NEVER British RP, and never use the length mark ː. Use American stress patterns (e.g., vaginal=/ˈvædʒənəl/ NOT British /vəˈdʒaɪnəl/, address(n)=/ˈædrɛs/ NOT /əˈdrɛs/, garage=/ɡəˈrɑʒ/ NOT /ˈɡærɑʒ/). Key rules: always include /r/ after vowels (car=/kɑr/ NOT /kɑ/), use /ɑ/ not /ɒ/ (lot=/lɑt/ NOT /lɒt/), use /æ/ not /ɑ/ in BATH words (bath=/bæθ/ NOT /bɑθ/), use /ɛr/ not /eə/ (care=/kɛr/ NOT /keə/), use /t/ not /ʔ/ (better=/ˈbɛtɚ/ NOT /ˈbeʔə/), use /ɚ/ for unstressed -er and /ɝ/ for stressed er (butter=/ˈbʌtɚ/, bird=/bɝd/), never a silent r",
  "definition": "string - Original English definition for THIS specific meaning/sense, at most 25 words. It must not be circular: never define the word with itself or a form of it",
  "forms": ["array of strings - Different grammatical forms (e.g., runs, running, ran)"],
  "wordFamily": ["array of objects - Related words of different parts of speech, each with { word, pos, chinese }"],
  "synonyms": ["array of strings - Synonyms for THIS specific meaning"],
  "antonyms": ["array of strings - Antonyms for THIS specific meaning"],
  "confusables": ["array of strings - Words easily confused with this (similar spelling, sound, or meaning), including English words that share its Chinese translation (e.g., borrow/lend are both 借, see/watch/look are all 看). Empty array if none"],
  "examples": ["array of 2 strings - Sentences that sound like a real American SPEAKING out loud, not a textbook or an essay. Channel how people actually talk in everyday conversation, podcasts, and interviews: relaxed, direct, concrete, and a little opinionated. Use contractions (it's, don't, you're, that's, gonna), first/second-person framing (I, you, we), short punchy clauses, strong plain verbs, and modern real-life situations (work, startups, tech, money, friends, sports, daily life). Casual intensifiers and asides are good (honestly, basically, way too, a ton of, kind of, no joke). Use American spelling and idioms (color, realize, awesome, line up). Keep the delivery casual EVEN WHEN the target word is advanced — a sharp native speaker drops a precise, fancy word straight into plain everyday speech, and that contrast is exactly the effect you want. STRICTLY AVOID stiff/formal/academic/literary phrasing, passive voice, and bookish connectors (thus, hence, moreover, furthermore, whilst, one might say). Each sentence must still make the word's meaning obvious from context. EXCEPTIONS to the American conversational style: for a british_only sense, write natural British speech (British spelling and settings); for a rare_or_dated sense, set the sentence in a literary, historical, or period context where that usage is natural. Then add TWO kinds of markup: (1) Each sentence MUST contain the word/phrase being defined (or a natural variant — different tense/number, or for an idiom a substituted word); wrap THAT target item, exactly as it appears, in {{double curly braces}} exactly once per sentence. Keep a phrasal verb and its particle inside that one marker, even when an object splits them ({{turned it down}}, never {{turned}} it {{down}}). (2) Wrap at most TWO other genuinely uncommon / C1-C2 words, idioms, or advanced collocations that happen to appear — NOT the target item, and NEVER basic/common words — in [[double square brackets]] so learners can tap them to look them up; most sentences need one or none. Never mark everyday words, even long or emotional ones (nightmare, marketing, exhausted, chaos, anxiety, mess, incredible, cozy, seriously, blunt, liability). e.g. for 'reckless': 'He was driving like a total maniac — just {{reckless}}, blowing through red lights like he was [[invincible]].' e.g. for the idiom 'fall on deaf ears': 'I kept telling them the plan was way over budget, but it {{fell on deaf ears}}.' and the variant 'Her feedback was honest and super specific, and it still {{fell on deaf ears}} — they just kept doing their own thing.'"],
  "history": "string - Etymology and semantic evolution: Where the word comes from AND how/why it evolved to its current meaning. Explain the journey from original meaning to modern usage (2-3 sentences). If the origin is uncertain or disputed, say so plainly; never invent an etymology or folk story",
  "register": "string - One full sentence on how common this sense is and where it is used (e.g., 'Common in casual American speech, but too informal for business writing.')",
  "mnemonic": "string - A memory aid tying the word's sound or spelling to THIS specific meaning, built from the word's real parts when they help and consistent with 'history' (e.g., bene- 'well' + -volent 'wishing' for benevolent). When the parts don't help, use a sound-alike that starts with 'Sounds like'. Never invent a fake etymology (bad: inert = 'in + earth'), and never just restate the definition or explain the word with itself (bad: worth = 'it's WORTH it')",
  "imagePrompt": "string - A prompt to generate an illustrative image for THIS specific meaning",
  "usageAudit": {
    "status": "EXACTLY one of: modern_american, current_general, british_only, rare_or_dated, narrow_specialized",
    "reason": "string - Concise evidence-based note about THIS exact sense's usefulness in modern American English. For british_only, name the normal American equivalent when one exists",
    "confidence": "EXACTLY one of: high, medium, low"
  }
}

EXAMPLE QUALITY GATE (mandatory for every vocab card):
- Return EXACTLY TWO examples, never one and never more than two.
- Use the two strongest, most natural examples. They must show two clearly different real-life contexts and make this exact sense obvious without sounding written, academic, or contrived.
- Each example must contain exactly one nonempty {{studied target}} marker around the natural form used in that sentence.
- Mark only the other expressions that would be genuinely uncommon or non-obvious to a C1/C2 learner with [[double square brackets]], at most two per sentence. Keep ordinary A1-B2 language unmarked.
- Use no other curly braces or square brackets anywhere in an example.
- Do not return duplicate or lightly reworded examples.`;

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
  "pronunciation": "string - General American (GA) IPA of the full input inside one pair of slashes. MUST be rhotic American, NEVER British RP, with no length marks. Always include /r/ after vowels, use /ɑ/ not /ɒ/, use /æ/ not /ɑ/ in BATH words, use /ɛr/ not /eə/",
  "vocabs": [
    ${VOCAB_SCHEMA_DESCRIPTION}
  ]
}`;

// The input is not a word at all: answer with a flag instead of inventing a meaning (the route returns 422).
const NOT_FOUND_RULE = `
CRITICAL - GIBBERISH:
If the input is not a real English word or phrase and not a recognizable misspelling of one (random letters or
keyboard mashing such as "asdfgh" or "qwxzv"), do not invent a meaning. Respond with exactly
{"notFound": true, "query": <the input exactly as given>} and nothing else.`;

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
A real word that is rare, new, or slang (e.g., "sesquipedalian", "yeet", "rizz") is NOT a typo: analyze it as written
instead of "correcting" it to a more common word.
${NOT_FOUND_RULE}

CRITICAL - CHINESE INPUT:
If the input is in Chinese (e.g., 坚韧, 银行, 不屈不挠), choose the ONE English word or phrase that best matches it and analyze only that headword.
- "坚韧" → analyze "tenacity"
- "银行" → analyze "bank"
- "不屈不挠" → analyze "indomitable"
- "打破僵局" → analyze "break the ice"
Set the 'query' field in your response to the English word/phrase you chose. Never mix cards for several English candidates;
list close alternatives (e.g., "resilience", "tough" for 坚韧) only in 'synonyms'.
Create vocabulary cards for the English word, exactly as if the user had typed it in English.

CRITICAL - USE BASE/DICTIONARY FORMS:
If the input is an inflected form, you MUST normalize it to the base/lemma form (the dictionary entry form):
- Verbs: "hidden" → "hide", "running" → "run", "went" → "go", "touted" → "tout", "eaten" → "eat"
- Adjectives: "happier" → "happy", "best" → "good", "worse" → "bad"
- Nouns: "children" → "child", "mice" → "mouse" (irregular plurals only)
- Adverbs: "better" (as adverb) → "well"
Keep the form as typed when it is its own dictionary entry: plural-only or plural-meaning nouns ("glasses", "manners",
"savings", "arms" as weapons), participial adjectives ("bored", "advanced", "interested"), and fixed expressions
containing an inflected word ("used to", "had better", "given that").
The 'word' field in your response should contain the BASE FORM that a learner would look up in a dictionary.
Include the original input form in the 'forms' array.

CRITICAL - WHICH MEANINGS TO INCLUDE AND HOW TO ORDER THEM:
Create a SEPARATE vocab card for every distinct, established dictionary meaning of the headword,
including British-only, rare/dated, and genuinely specialized meanings. This makes the result
future-proof: never silently omit an established sense merely because it is low priority.
Give at most ${MAX_CARDS_PER_HEADWORD} cards: if the headword has more distinct meanings, keep the
${MAX_CARDS_PER_HEADWORD} most useful, in the order described below.
- Different parts of speech = different cards (noun vs verb vs adjective)
- Different literal vs figurative meanings = different cards
- Merge tiny dictionary sub-senses that have essentially the same definition and usage; do not
  manufacture distinctions just to make the list longer
- Omit only proper-name uses, obvious one-off contextual metaphors, and senses that are not
  independently established lexical meanings

Every card MUST classify its EXACT sense with usageAudit:
- modern_american: current and especially characteristic of everyday American English
- current_general: current, useful English that is normal and readily understood in the US
- british_only: current chiefly in British English but not normal American usage
- rare_or_dated: rare, dated, archaic, obsolete, historical, or chiefly literary today
- narrow_specialized: current but mainly limited to a technical/professional domain

ORDER the cards by usefulness to a modern American-English learner: the most frequent everyday
modern_american/current_general sense first, then other current senses, then narrow_specialized,
british_only, and rare_or_dated senses. Within each group put the more frequent sense first.

Example: "bank" should produce these everyday cards:
1. bank (noun: finance) - "A financial institution..."
2. bank (noun: geography) - "The side of a river..."
3. bank (verb: to rely) - "To depend on something..."
(Put narrow or archaic senses after these mainstream senses and label them accurately.)

Each card MUST have:
- The SAME 'word' field (the BASE/DICTIONARY form, not the original inflected input)
- A UNIQUE 'sense' field (e.g., "noun: emotion", "verb: to cause", "adj: describing")
- Definition, examples, synonyms, antonyms specific to THAT meaning only
- Different Chinese translations for each sense
- Mnemonic specific to that meaning
- Confusables: words often confused with this one (similar spelling, sound, or meaning, or a shared Chinese translation)
  Examples: affect/effect, accept/except, complement/compliment, principal/principle, borrow/lend
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

The usageAudit is mandatory and applies to the specific sense, not merely to the headword.

${WORD_MODE_JSON_SCHEMA}`;

const BATCH_WORD_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has provided a WORD or PHRASE that has already been identified as an uncommon/advanced vocabulary item worth studying.

CRITICAL — TREAT THE INPUT AS A SINGLE UNIT:
The input is a pre-identified vocabulary item. Do NOT split it into component words.
If the input is a multi-word phrase (e.g., "a blessing in disguise", "run the gamut", "by and large"),
analyze the ENTIRE phrase as one vocabulary entry. Create card(s) for the phrase itself, NOT for
individual words within it.

CRITICAL - HANDLE TYPOS AND MISSPELLINGS:
If the input appears to be misspelled or contains a typo, AUTOMATICALLY CORRECT IT to the most likely intended word.
Use your best judgment to determine what the user meant. The 'word' field should contain the CORRECT spelling.
A real word that is rare, new, or slang (e.g., "sesquipedalian", "yeet", "rizz") is NOT a typo: analyze it as written.
${NOT_FOUND_RULE}

CRITICAL - CHINESE INPUT:
If the input is in Chinese, choose the ONE English word or phrase that best matches it and analyze only that headword.
Set the 'query' field in your response to the English word/phrase you chose.

CRITICAL - USE BASE/DICTIONARY FORMS:
If the input is an inflected form, normalize to the base/lemma form:
- Verbs: "hidden" → "hide", "running" → "run"
- Adjectives: "happier" → "happy"
Keep the form as given when it is its own dictionary entry ("glasses", "manners", "savings", "bored", "used to", "had better").
The 'word' field should contain the BASE FORM.

CRITICAL - WHICH MEANINGS TO INCLUDE:
Create SEPARATE vocab cards for every distinct, established meaning of the word/phrase AS A WHOLE,
at most ${MAX_CARDS_PER_HEADWORD}: if it has more distinct meanings, keep the ${MAX_CARDS_PER_HEADWORD} most useful.
- Different parts of speech = different cards
- Literal vs figurative = different cards
Include and accurately label British-only, rare/dated, and specialized senses; put them after
current American/general senses. Don't split one meaning into near-identical cards.

Every card MUST have usageAudit for its exact sense. Use only modern_american, current_general,
british_only, rare_or_dated, or narrow_specialized, and order the cards from most useful/common
for a modern American-English learner to least useful.

Each card MUST have:
- The SAME 'word' field (the complete phrase or base word, NOT individual components)
- A UNIQUE 'sense' field
- Definition, examples, synonyms, antonyms specific to THAT meaning only
- Different Chinese translations for each sense
- Mnemonic specific to that meaning
- Confusables: similar expressions often confused with this one
- Forms: variations of the phrase/word
- Word Family: related expressions

${WORD_MODE_JSON_SCHEMA}`;

const SENTENCE_MODE_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
The user has entered a SENTENCE or longer text.

CRITICAL - HANDLE TYPOS AND MISSPELLINGS:
If the input contains misspelled words or typos, AUTOMATICALLY CORRECT THEM when analyzing.
Treat the sentence as if it were spelled correctly. Extract vocabulary based on the corrected words.
A real word that is rare, new, or slang (e.g., "rizz", "sus", "gaslight") is NOT a typo: keep it as written.

CRITICAL - CHINESE INPUT:
If the input is in Chinese, translate it to natural English and analyze the English version.
- Set the 'query' field to the English translation of the sentence
- Set the 'translation' field to the original Chinese (or a refined version)
- Analyze grammar, pronunciation, and vocabulary based on the English equivalent
Treat the analysis exactly as if the user had entered the English sentence directly.

Your task: Provide a comprehensive analysis including:
1. translation - Precise Chinese translation (always required)
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
Keep the form as written when it is its own dictionary entry ("glasses", "manners", "savings", "bored", "used to", "had better").
The 'word' field should contain the base form that a learner would look up in a dictionary.

CRITICAL - VOCABULARY EXTRACTION:
Extract phrasal verbs, idioms, and multi-word expressions as COMPLETE phrases (not individual words).
- "bank on" should be extracted as "bank on" (not just "bank")
- "couldn't help but" should be extracted as "couldn't help but"
- "even though" can be extracted if it adds learning value

CRITICAL - INCLUDE AND AUDIT EVERY ESTABLISHED MEANING (most important rule):
Once a word/phrase is selected for extraction, include every distinct established meaning as a
SEPARATE vocab card — not only the one used in the sentence context. Include British-only,
rare/dated, and specialized senses, classify each exact sense with the mandatory usageAudit,
and put the most common/useful modern American meanings first. Don't split one meaning into
near-identical cards. Give at most ${MAX_CARDS_PER_HEADWORD} cards for any one word/phrase, keeping the most useful.

Example: If extracting "zest" from a cooking sentence:
- Card 1: zest (noun: culinary) - "The outer peel of citrus fruit..."
- Card 2: zest (noun: enthusiasm) - "Great energy and enjoyment..."
Both senses are everyday, so include both.

Example: If extracting "bank" from any sentence:
- Create cards for its everyday meanings: financial institution, river bank, to rely on.
- Include narrow/technical senses (e.g. tilting an aircraft) after the everyday senses and label them narrow_specialized.

Each card MUST include ALL fields with the SAME depth as Word Mode:
- word, sense, chinese, ipa, definition, forms, synonyms, antonyms, confusables, examples, history, register, mnemonic, imagePrompt
- Forms: grammatical variations (e.g., "bank on" → banks on, banked on, banking on)
- Confusables: similar phrases that might be confused

Only extract words/phrases that are C1/C2 level, idiomatic, or have interesting nuance.
Be thorough - the user should get the same quality whether they search a word directly or extract it from a sentence.

${SENTENCE_MODE_JSON_SCHEMA}`;

// Targeted re-ask: only the cards that failed validation, each with the validator's reasons.
const CARD_REPAIR_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach.
Some vocabulary cards you wrote failed our automatic checks. Rewrite ONLY the cards you are given, fixing every listed problem.
- Keep each card's "word" and "sense" exactly as given, so each rewritten card replaces its original.
- Keep everything that was already correct, and return EVERY field of each card, not just the fixed ones.
- Return the cards in the order you received them.

${VOCAB_SCHEMA_DESCRIPTION}

You MUST respond with valid JSON in this exact format:
{
  "vocabs": [ one complete vocab object for each card you were given ]
}`;

const TEXT_DETECT_INSTRUCTION = `
You are PopDict, an expert ESL vocabulary scanner.

Scan the user's text and identify all rare, advanced (C1/C2+), idiomatic, or interesting English vocabulary that would be worth studying for an intermediate-to-advanced learner.

## WHAT TO DETECT (in order of priority)
- Idioms and idiomatic expressions ("break the ice", "bite the bullet")
- Phrasal verbs with non-obvious meanings ("bank on", "come across")
- C1/C2 level vocabulary (tenacity, ephemeral, ubiquitous, etc.)
- Academic or formal register words
- Widely-used domain terms that have entered general usage (e.g. "algorithm", "placebo") — but NOT narrow specialist jargon
- Words used in figurative, metaphorical, or unusual ways
- Interesting collocations and fixed expressions

## WHAT TO SKIP
- Common everyday words (go, make, have, take, get, do, say, think, know, want, like, etc.)
- Basic B1/B2 vocabulary that intermediate learners already know comfortably
- Proper nouns (names of people, places, brands)
- Function words (the, a, an, is, are, was, were, this, that, which, etc.)
- Archaic, obsolete, or purely literary/poetic words and senses
- Narrow domain jargon (chemistry, anatomy, geology, law, finance, computing, etc.) that a general educated reader wouldn't know — unless it has crossed into everyday use
- Ultra-rare words so specialized that even a well-read high-school student wouldn't know them

## EXTRACTION COUNT
Return only items genuinely worth studying. Never pad the list to reach a number.
- Short text (under 50 words): 1-8 items
- Medium text (50-150 words): up to 10 items
- Long text (150+ words): up to 12 items, the most valuable ones
- Never return more than 12 items. If nothing qualifies, return an empty "words" array.
- If the whole input is a single idiom or fixed expression, return just that one expression.

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
  "sourceLang": "string - 'zh' if the input text is (mostly) Chinese, otherwise 'en'",
  "translation": "string - If the input was Chinese, the natural English translation of the WHOLE text (this is the text you detected the vocabulary from). If the input was already English, return an empty string.",
  "words": [
    {
      "word": "string - The word or expression in base/dictionary form",
      "context": "string - The original phrase from the text where this appears (5-15 words around it)",
      "level": "string - e.g. C1, C2, idiom, phrasal verb, formal, academic, literary",
      "reason": "string - One-line explanation of why this is worth studying"
    }
  ]
}

Return ONLY the word list (plus sourceLang and translation). Do NOT provide full definitions, examples, etymology, or detailed analysis.
This is a quick scan — the user will choose which words to study in depth.`;

const COMPARE_WORDS_INSTRUCTION = `
You are PopDict, an expert C1 Advanced ESL coach specializing in vocabulary nuance.
The user will give you TWO TO ${MAX_COMPARE_WORDS} English words that are similar in meaning (often 2-3).
There may be more than three words — the "word1"/"word2"/"word3" keys below are just examples; include an
entry for EVERY word the user gives, using the word itself exactly as given as the key, in "words", every
"perWord", and each example's "sentences" (one key per word, no omissions).

Your task: Create a detailed, structured comparison that helps a Chinese-speaking learner understand EXACTLY when to use each word.

Analyze the words across EXACTLY these THREE dimensions (keep each concise — about one sentence per word):
1. Core Meaning — What each word fundamentally means and how the meanings differ
2. Register & Formality — Is one more formal, literary, casual, or technical?
3. Collocations — What words commonly appear WITH each one? (e.g., "fleeting glance" but NOT "transient glance")

Provide 2 contextual examples showing the SAME scenario but using each word, so the learner can see the difference in practice.

List common mistakes Chinese learners make when choosing between these words.

End with a clear, memorable verdict/rule of thumb.

You MUST respond with valid JSON in this exact format:
{
  "words": ["word1", "word2", "word3"],
  "summary": "string - One concise sentence capturing the KEY difference. When the words share a Chinese translation, name it (e.g., 'All three are 短暂的 in Chinese, but...')",
  "dimensions": [
    {
      "label": "string - Dimension name (e.g., 'Core Meaning')",
      "analysis": "string - ONE concise sentence comparing all words on this dimension",
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
  "verdict": "string - A memorable rule of thumb (1-2 sentences) for choosing between these words"
}

IMPORTANT (keep the response compact so it generates quickly):
- Include EXACTLY 3 dimensions (core meaning, register, collocation) — concise, not exhaustive
- Include 2 contextual examples
- Include 2-3 common mistakes
- The verdict should be practical and memorable (1-2 sentences)
- Use Chinese translations in parentheses where helpful for the Chinese-speaking learner
- Be specific and concrete, not vague`;

const TRUNCATION_FEEDBACK = `

Your previous answer was too long and was cut off before it finished. Answer again more compactly: keep every
field brief (a definition of at most 25 words, a history of at most 2 sentences, a one-sentence register note,
short examples), merge near-duplicate senses, and if the item has more than ${MAX_CARDS_PER_HEADWORD} distinct meanings, give the
${MAX_CARDS_PER_HEADWORD} most useful.`;

// ============================================================================
// Helper functions
// ============================================================================

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function errorResponse(msg: string, status: number) {
  return { error: msg, status };
}

const trimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A map of non-empty strings under non-empty keys; anything else (numbers, objects, blanks) is dropped. */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const word = key.trim();
    const text = trimmedString(entry);
    return word && text ? [[word, text] as [string, string]] : [];
  }));
}

/**
 * Keep only what the comparison view can render: string-only per-word maps, dimensions with a label
 * and some content, examples with at least one sentence. Null when no dimension survives.
 */
export function sanitizeComparison(raw: Record<string, any>, requestedWords: string[]) {
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).flatMap((dimension: any) => {
    if (!dimension || typeof dimension !== 'object') return [];
    const label = trimmedString(dimension.label);
    const analysis = trimmedString(dimension.analysis);
    const perWord = stringMap(dimension.perWord);
    return label && (analysis || Object.keys(perWord).length > 0) ? [{ label, analysis, perWord }] : [];
  });
  if (dimensions.length === 0) return null;
  const examples = (Array.isArray(raw.examples) ? raw.examples : []).flatMap((example: any) => {
    if (!example || typeof example !== 'object') return [];
    const sentences = stringMap(example.sentences);
    return Object.keys(sentences).length > 0 ? [{ context: trimmedString(example.context), sentences }] : [];
  });
  const modelWords = Array.isArray(raw.words) ? raw.words.map(trimmedString) : [];
  return {
    words: modelWords.length === requestedWords.length && modelWords.every(Boolean) ? modelWords : requestedWords,
    summary: trimmedString(raw.summary),
    dimensions,
    examples,
    commonMistakes: (Array.isArray(raw.commonMistakes) ? raw.commonMistakes : []).map(trimmedString).filter(Boolean),
    verdict: trimmedString(raw.verdict),
  };
}

export interface DetectedWord {
  word: string;
  context: string;
  level: string;
  reason: string;
}

/** Only the four scan fields, trimmed; the same expression (ignoring case and spacing) is kept once; at most 12. */
export function sanitizeDetectedWords(value: unknown): DetectedWord[] {
  const seen = new Set<string>();
  const words: DetectedWord[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { word, context, level, reason } = entry as Record<string, unknown>;
    if (typeof word !== 'string' || !word.trim() ||
        typeof context !== 'string' || typeof level !== 'string' || typeof reason !== 'string') continue;
    const key = word.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    words.push({ word: word.trim(), context: context.trim(), level: level.trim(), reason: reason.trim() });
    if (words.length === MAX_EXTRACTED_WORDS) break;
  }
  return words;
}

// ============================================================================
// Analysis generation
// ============================================================================

const cardKey = (card: any): string =>
  `${trimmedString(card?.word).toLowerCase()}|${trimmedString(card?.sense).toLowerCase()}`;

// A live card may go without a register note (normalization drops one under the stored-corpus minimum and
// the local cycle writes it later); every other field keeps the stored-corpus minimums.
const liveIssues = (card: unknown): string[] => vocabValidationIssues(card, { optionalRegister: true });

interface CardSlot {
  card: any;
  /** Position in the model's (usage-sorted) answer, so a repaired card keeps its place. */
  index: number;
}

interface FailingCard extends CardSlot {
  issues: string[];
}

function repairPrompt(headword: string, failing: FailingCard[]): string {
  const sections = failing.map((entry, position) => [
    `Card ${position + 1} (sense: ${JSON.stringify(entry.card.sense)})`,
    'Problems:',
    ...entry.issues.map(issue => `- ${issue}`),
    'Card as written:',
    JSON.stringify(entry.card),
  ].join('\n'));
  return `Headword: ${JSON.stringify(headword)}\n\n${sections.join('\n\n')}`;
}

/**
 * Ask the model to rewrite only the failing cards, telling it why each failed. A rewritten card is
 * matched to its original by word and sense (or by position when the counts agree); cards that still
 * fail, or that did not come back, are returned for another round.
 */
async function repairCards(
  chat: ChatJson,
  ctx: AiRequestContext,
  headword: string,
  failing: FailingCard[],
  round: number,
): Promise<{ fixed: CardSlot[]; stillFailing: FailingCard[] }> {
  const raw = await chat(ctx, {
    system: CARD_REPAIR_INSTRUCTION,
    user: repairPrompt(headword, failing),
    maxTokens: REPAIR_MAX_TOKENS,
    temperature: REPAIR_TEMPERATURE,
    label: `card repair ${round}`,
  });
  const rewritten: unknown[] = Array.isArray(raw.vocabs) ? raw.vocabs : [];
  const positional = rewritten.length === failing.length;
  const byKey = new Map(failing.map(entry => [cardKey(entry.card), entry]));
  const unmatched = new Set(failing);
  const fixed: CardSlot[] = [];
  const stillFailing: FailingCard[] = [];
  const auditedAt = Date.now();
  rewritten.forEach((rawCard, position) => {
    const card = normalizeVocabCard(rawCard, headword, auditedAt);
    if (!card) return;
    let original = byKey.get(cardKey(card));
    if (original && !unmatched.has(original)) original = undefined;
    if (!original && positional && unmatched.has(failing[position])) original = failing[position];
    if (!original) return;
    unmatched.delete(original);
    const issues = liveIssues(card);
    if (issues.length === 0) fixed.push({ card, index: original.index });
    else stillFailing.push({ card, index: original.index, issues });
  });
  stillFailing.push(...unmatched);
  return { fixed, stillFailing };
}

/**
 * The model's order (repaired cards in their original places), one card per word and sense, sorted by usage,
 * and at most MAX_CARDS_PER_HEADWORD for any one headword.
 */
function finalizeCards(slots: CardSlot[]): any[] {
  const seen = new Set<string>();
  const cards = [...slots].sort((a, b) => a.index - b.index).map(slot => slot.card).filter(card => {
    const key = cardKey(card);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const perHeadword = new Map<string, number>();
  return sortVocabsByUsage(cards).filter(card => {
    const headword = trimmedString(card?.word).toLowerCase();
    const count = (perHeadword.get(headword) ?? 0) + 1;
    perHeadword.set(headword, count);
    return count <= MAX_CARDS_PER_HEADWORD;
  });
}

function reaskFeedback(isWord: boolean, inputCards: number, issues: string[]): string {
  const reasons = [...new Set(issues)].slice(0, 12).map(issue => `- ${issue}`).join('\n');
  if (isWord && inputCards === 0) {
    return '\n\nYour previous answer contained no vocabulary cards. Return complete cards for every established meaning, ' +
      'or {"notFound": true, "query": <the input>} if the input is not a real English word or phrase.';
  }
  const lead = isWord
    ? 'Your previous answer had no usable vocabulary cards.'
    : 'Your previous answer had an empty "translation" and no usable vocabulary cards. The Chinese translation is mandatory.';
  return `\n\n${lead}${reasons ? ` Every card must avoid these problems:\n${reasons}` : ''}`;
}

export interface AnalysisResult {
  rawData: any;
  isWord: boolean;
  originalQuery?: string;
  resolvedQuery: string;
}

/**
 * Generate an analysis inside one request budget. Cards are repaired deterministically during
 * normalization, then validated one by one: passing cards are kept, and only the failing ones are
 * re-asked with the validator's reasons. A reply that is cut off, or that has nothing usable, gets
 * one full re-ask. Gibberish ends at once as not_found (422) with no retries.
 */
export async function generateAnalysisData(
  chat: ChatJson,
  ctx: AiRequestContext,
  text: string,
  mode?: 'batch',
): Promise<AnalysisResult> {
  const query = text.trim();
  const isBatch = mode === 'batch';
  const originalQuery = containsChinese(text) ? text : undefined;
  const isWord = isBatch || isWordOrPhrase(query);
  // The input is embedded as a JSON string so quotes or newlines in it cannot rewrite the instructions.
  const userPrompt = isWord
    ? (isBatch
      ? `Analyze this pre-identified vocabulary item (given as a JSON string) for a C1 learner. Treat it as a SINGLE phrase — do NOT split into component words. Create vocabulary cards for ALL its meanings: ${JSON.stringify(query)}`
      : `Analyze this word or phrase (given as a JSON string) for a C1 learner. Create vocabulary cards for ALL its meanings: ${JSON.stringify(query)}`)
    : `Analyze this sentence (given as a JSON string) for a C1 learner: ${JSON.stringify(query)}`;
  const system = isWord ? (isBatch ? BATCH_WORD_MODE_INSTRUCTION : WORD_MODE_INSTRUCTION) : SENTENCE_MODE_INSTRUCTION;
  let feedback = '';
  let lastFailure: AiError | undefined;

  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
    if (attempt > 1 && remainingMs(ctx) < MIN_ANALYSIS_ATTEMPT_WINDOW_MS) {
      console.warn(`Analysis: ${remainingMs(ctx)}ms left, too little for another full attempt`);
      break;
    }
    let modelData: Record<string, any>;
    try {
      modelData = await chat(ctx, { system, user: userPrompt + feedback, maxTokens: ANALYSIS_MAX_TOKENS, label: `analysis ${attempt}` });
    } catch (error) {
      const failure = classifyAiError(error, ctx.clientSignal);
      if (failure.kind !== 'truncated') throw failure;
      console.warn(`Analysis attempt ${attempt} was cut off at max_tokens`);
      lastFailure = failure;
      feedback = TRUNCATION_FEEDBACK;
      continue;
    }

    const normalized = normalizeAnalysisResponse(modelData, { fallbackQuery: query });
    const data = normalized.data;
    if (isWord && data.vocabs.length === 0 && (modelData.notFound === true || modelData.notFound === 'true')) {
      throw new AiError('not_found', `No dictionary entry for ${JSON.stringify(query)}`);
    }
    if (normalized.droppedCards > 0) {
      console.warn(`Analysis attempt ${attempt}: dropped ${normalized.droppedCards}/${normalized.inputCards} cards without a headword or definition`);
    }

    const passing: CardSlot[] = [];
    let failing: FailingCard[] = [];
    data.vocabs.forEach((card: any, index: number) => {
      const issues = liveIssues(card);
      if (issues.length === 0) passing.push({ card, index });
      else failing.push({ card, index, issues });
    });
    console.log(`Analysis attempt ${attempt}: ${passing.length}/${data.vocabs.length} cards passed validation` +
      (failing.length ? `; repairing ${failing.length}` : ''));
    for (const entry of failing) {
      console.warn(`  failed "${entry.card.word}" (${entry.card.sense}): ${entry.issues.join('; ').slice(0, 500)}`);
    }

    let repairFailure: AiError | undefined;
    for (let round = 1; failing.length > 0 && round <= MAX_REPAIR_ROUNDS; round++) {
      if (remainingMs(ctx) < MIN_REPAIR_WINDOW_MS) {
        console.warn(`Analysis: ${remainingMs(ctx)}ms left, too little to repair ${failing.length} card(s)`);
        break;
      }
      try {
        const { fixed, stillFailing } = await repairCards(chat, ctx, data.query || query, failing, round);
        console.log(`Analysis repair round ${round}: fixed ${fixed.length}/${failing.length} card(s)`);
        passing.push(...fixed);
        failing = stillFailing;
      } catch (error) {
        repairFailure = classifyAiError(error, ctx.clientSignal);
        if (repairFailure.kind === 'cancelled') throw repairFailure;
        console.warn(`Analysis repair round ${round} failed (${repairFailure.kind}: ${repairFailure.message})`);
        break;
      }
    }
    if (failing.length > 0) {
      console.warn(`Analysis: dropping ${failing.length} card(s) that still fail validation; keeping ${passing.length}`);
    }

    data.vocabs = finalizeCards(passing);
    const usable = isWord ? data.vocabs.length > 0 : Boolean(data.translation.trim()) || data.vocabs.length > 0;
    if (usable) return { rawData: data, isWord, originalQuery, resolvedQuery: data.query || query };

    if (isWord && normalized.inputCards === 0) {
      lastFailure = new AiError('not_found', `The model returned no cards for ${JSON.stringify(query)}`);
    } else {
      lastFailure = repairFailure ?? new AiError('invalid', isWord
        ? 'No generated card passed validation'
        : 'The sentence analysis had no translation and no usable cards');
    }
    feedback = reaskFeedback(isWord, normalized.inputCards, failing.flatMap(entry => entry.issues));
    console.warn(`Analysis attempt ${attempt} had nothing usable (${lastFailure.message})`);
  }
  throw lastFailure ?? new AiError('invalid', 'Analysis response validation failed');
}

// ============================================================================
// Routes
// ============================================================================

const ANALYSIS_ERRORS: AiErrorMessages = {
  label: 'Analysis',
  failed: 'Analysis failed. Please try again.',
  notFound: 'No dictionary entry found. Check the spelling and try again.',
};

export interface AiRouteDependencies {
  /** Outbound HTTP; proxyFetch unless a test injects a stub. */
  fetch?: FetchLike;
  apiKey?: () => string | undefined;
  retryDelayMs?: number;
  budgetsMs?: Partial<Record<'analyze' | 'compare' | 'extract' | 'transcribe', number>>;
}

export function createAiRoutes(deps: AiRouteDependencies = {}) {
  const doFetch = deps.fetch ?? proxyFetch;
  const apiKey = deps.apiKey ?? (() => env.DEEPINFRA_API_KEY);
  const chat = createChatClient({ fetch: doFetch, apiKey, retryDelayMs: deps.retryDelayMs });
  const budgets = {
    analyze: deps.budgetsMs?.analyze ?? ANALYSIS_BUDGET_MS,
    compare: deps.budgetsMs?.compare ?? COMPARE_BUDGET_MS,
    extract: deps.budgetsMs?.extract ?? EXTRACT_BUDGET_MS,
    transcribe: deps.budgetsMs?.transcribe ?? TRANSCRIBE_BUDGET_MS,
  };
  const routes = new Hono();

  // POST /api/analyze — analyze a word/phrase/sentence
  routes.post('/analyze', async (c) => {
    // Read the disconnect signal first: the Node adapter only aborts it once it has been accessed.
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { text, mode } = await c.req.json().catch(() => ({}));
    if (typeof text !== 'string' || text.trim().length === 0) {
      return c.json(errorResponse('Missing "text" field', 400), 400);
    }
    if (text.trim().length > 5000) {
      return c.json(errorResponse('Text is too long (maximum 5000 characters).', 400), 400);
    }

    const isBatch = mode === 'batch';
    const originalQuery = containsChinese(text) ? text : undefined;
    // In batch mode, always treat input as a word/phrase (it's a pre-identified vocabulary item)
    const isWord = isBatch || isWordOrPhrase(text);
    console.log(`Analyze request: ${text.length} chars, ${isWord ? 'word/phrase' : 'sentence'}${isBatch ? ', batch' : ''}${originalQuery ? ', Chinese' : ''}`);

    const ctx = createRequestContext(clientSignal, budgets.analyze);
    try {
      const { rawData, resolvedQuery } = await generateAnalysisData(chat, ctx, text, isBatch ? 'batch' : undefined);
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
      }
      return c.json({ ...rawData, originalQuery, query: resolvedQuery });
    } catch (error) {
      return aiErrorResponse(c, error, ANALYSIS_ERRORS, clientSignal);
    }
  });

  // POST /api/extract-vocabulary — detect interesting words in text
  routes.post('/extract-vocabulary', async (c) => {
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { text } = await c.req.json().catch(() => ({}));
    // Low floor (not 10): the main search routes short sentences (e.g. "Go away!", brief Chinese) here too.
    if (!text || typeof text !== 'string' || text.trim().length < 2) {
      return c.json(errorResponse('Please provide some text to analyze.', 400), 400);
    }

    const maxChars = 5000;
    const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
    const userPrompt = `Scan this text (given as a JSON string) and identify all rare, advanced, or interesting vocabulary worth studying:\n\n${JSON.stringify(truncatedText)}`;

    const ctx = createRequestContext(clientSignal, budgets.extract);
    try {
      const rawData = await chat(ctx, { system: TEXT_DETECT_INSTRUCTION, user: userPrompt, maxTokens: EXTRACT_MAX_TOKENS, label: 'vocabulary scan' });
      if (!Array.isArray(rawData.words) || rawData.words.length === 0) {
        return c.json(errorResponse('No interesting vocabulary found in the text.', 404), 404);
      }
      const words = sanitizeDetectedWords(rawData.words);
      if (words.length === 0) throw new AiError('invalid', 'Every detected word was malformed');
      return c.json({
        words,
        // Surface the translate-first step: when the input was Chinese, the model returns the English it
        // actually scanned. The client shows this (Text Analyzer) and uses it in the search status toast.
        translation: typeof rawData.translation === 'string' ? rawData.translation : '',
        sourceLang: rawData.sourceLang === 'zh' ? 'zh' : 'en',
      });
    } catch (error) {
      return aiErrorResponse(c, error, {
        label: 'Vocabulary detection',
        failed: 'Vocabulary detection failed. Please try again.',
        timeout: 'Timed out. Try a shorter text.',
      }, clientSignal);
    }
  });

  // POST /api/compare — compare 2 to MAX_COMPARE_WORDS words
  routes.post('/compare', async (c) => {
    const clientSignal = c.req.raw.signal;
    if (!apiKey()) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { words } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(words)) {
      return c.json(errorResponse('Please provide at least 2 words to compare.', 400), 400);
    }
    const seen = new Set<string>();
    const cleanWords = words
      .map((w: unknown) => trimmedString(w))
      .filter((w: string) => {
        const key = w.toLowerCase();
        if (!w || w.length > 100 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (cleanWords.length < 2) {
      return c.json(errorResponse('Please provide at least 2 different words to compare.', 400), 400);
    }
    if (cleanWords.length > MAX_COMPARE_WORDS) {
      return c.json(errorResponse(`You can compare up to ${MAX_COMPARE_WORDS} words at a time.`, 400), 400);
    }

    const userPrompt = `Compare these words (given as a JSON array): ${JSON.stringify(cleanWords)}`;
    const ctx = createRequestContext(clientSignal, budgets.compare);
    try {
      const rawData = await chat(ctx, {
        system: COMPARE_WORDS_INSTRUCTION,
        user: userPrompt,
        maxTokens: COMPARE_MAX_TOKENS,
        timeoutMs: budgets.compare,
        label: 'comparison',
      });
      const comparison = sanitizeComparison(rawData, cleanWords);
      if (!comparison) throw new AiError('invalid', 'The comparison had no usable dimensions');
      return c.json(comparison);
    } catch (error) {
      return aiErrorResponse(c, error, {
        label: 'Comparison',
        failed: 'Comparison failed. Please try again.',
        timeout: 'Timed out. Please try again.',
      }, clientSignal);
    }
  });

  // POST /api/transcribe — speech-to-text with Whisper
  routes.post('/transcribe', async (c) => {
    const clientSignal = c.req.raw.signal;
    const key = apiKey();
    if (!key) return c.json(errorResponse('DEEPINFRA_API_KEY not configured', 500), 500);

    const { audio, mimeType = 'audio/webm' } = await c.req.json().catch(() => ({}));
    if (typeof audio !== 'string' || audio.length === 0 || audio.length > 24 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
      return c.json(errorResponse('Missing "audio" base64 data.', 400), 400);
    }
    if (typeof mimeType !== 'string' || !/^audio\/(?:mp4|mpeg|ogg|wav|webm)(?:;|$)/i.test(mimeType)) {
      return c.json(errorResponse('Unsupported audio type.', 415), 415);
    }
    // Recorders report codec parameters ("audio/webm;codecs=opus"); the upload name and type use the bare type.
    const baseType = mimeType.split(';')[0].trim().toLowerCase();
    const extension = baseType.split('/')[1] || 'webm';

    const ctx = createRequestContext(clientSignal, budgets.transcribe);
    try {
      const formData = new FormData();
      formData.append('audio', new Blob([Buffer.from(audio, 'base64')], { type: baseType }), `audio.${extension}`);
      const response = await doFetch(DEEPINFRA_WHISPER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
        signal: ctx.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) throw providerError(response.status, bodyText);
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new AiError('invalid', 'Whisper returned a non-JSON response');
      }
      return c.json({ text: trimmedString(data?.text) });
    } catch (error) {
      return aiErrorResponse(c, error, { label: 'Transcription', failed: 'Transcription failed. Please try again.' }, clientSignal);
    }
  });

  return routes;
}

export const aiRoutes = createAiRoutes();
