// Casual "style" track.
// A second rendition of each sentence in fast, reduced, movie-like speech. The cache "voice" field
// doubles as a STYLE token: any MiMo voice name (e.g. 'Mia') = the clear track; the CASUAL_STYLE
// sentinel = the casual recipe below. The clip is keyed by (style, ORIGINAL sentence) — so the
// client finds it from the on-screen text — while the AUDIO is a phonetically-reduced respelling the
// AI produces (e.g. "reaching"->"reachin'", "to him"->"ta 'im"). Vocabulary words are preserved; only
// pronunciation changes. Both clear and casual clips receive locally generated word timings.
import {
  AiError,
  classifyAiError,
  createChatClient,
  createChatTextClient,
  createRequestContext,
  type ChatJson,
  type ChatText,
} from '../ai-client.js';

// One respelling call, retry included, gets as long as one synthesis.
const RESPELLING_BUDGET_MS = 90_000;
// The batch respelling sends the backfill's sentences this many at a time.
export const RESPELLING_BATCH_SIZE = 20;

// Strict: respell for casual PRONUNCIATION only — never paraphrase, or the studied vocab is lost.
const REDUCE_SYS = (
  'Respell an English sentence to show how it is ACTUALLY pronounced in fast, casual, everyday/movie ' +
  'speech. This is for a vocabulary learner, so you MUST preserve every content word (nouns, verbs, ' +
  'adjectives, adverbs) EXACTLY as given — do NOT paraphrase, swap synonyms, delete/add words, or ' +
  'change the structure. ONLY allowed changes: contractions (cannot->can\'t, I am->I\'m); function-word ' +
  'reductions (going to->gonna, want to->wanna, got to->gotta, kind of->kinda, have to->hafta, for->fer, ' +
  'to->ta, them->\'em, him->\'im, and->an\', of->o\', because->\'cause); dropped -g (-ing -> -in\'); and ' +
  'optional "..." for a natural pause. Output ONLY the respelled line, nothing else.'
);
const REDUCE_BATCH_SYS = REDUCE_SYS + ' You will receive a numbered list; respond with JSON {"lines":[...]} ' +
  'containing one respelled line per input, in the SAME order and the SAME count.';

const chatText = createChatTextClient();
const chatJson = createChatClient();

// The model sometimes wraps its line in quotes: strip one wrapping pair of double quotes (straight or
// curly). Apostrophes ARE the respelling ("'cause", "goin'") and must survive. Null when nothing is left.
export function cleanCasualRespelling(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const wrapped = /^["\u201c\u201d]([\s\S]*)["\u201c\u201d]$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  return text || null;
}

// A batch line counts only when it respells its own sentence: of the batch's sentences, its own shares the most letter
// pairs with it (a line shifted from a neighbor shares more with that neighbor), and at least this much (Dice). A bar
// alone can't tell them apart: "I'm gonna go." scores 0.32 against "I am going to go.", while two unrelated short
// sentences can reach 0.4.
const MIN_RESPELLING_SIMILARITY = 0.2;

function letterPairs(text: string): Map<string, number> {
  const letters = text.toLowerCase().replace(/[^a-z]/g, '');
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < letters.length; i++) {
    const pair = letters.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return pairs;
}

/** The Dice similarity of two texts' letter pairs (a-z only): 1 for the same letters in the same order, 0 for none shared. */
export function letterPairSimilarity(a: string, b: string): number {
  const pairsA = letterPairs(a);
  const pairsB = letterPairs(b);
  let total = 0;
  let shared = 0;
  for (const count of pairsA.values()) total += count;
  for (const [pair, count] of pairsB) {
    total += count;
    shared += Math.min(count, pairsA.get(pair) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * The batch reply's lines, one per sentence, keeping only those that respell their own sentence. A list number the
 * model mirrored ("1. I'm gonna go.") is removed, unless the sentence itself starts with it; a line closer to another
 * sentence (one shifted from a neighbor) or to none is null, so its sentence is respelled on its own when its clip is
 * made.
 */
export function acceptBatchRespellings(sentences: string[], lines: unknown[]): Array<string | null> {
  return sentences.map((sentence, index) => {
    let text = cleanCasualRespelling(lines[index]);
    const echoed = new RegExp(`^${index + 1}\\s*[.):-]\\s+`);
    if (text && echoed.test(text) && !echoed.test(sentence)) text = cleanCasualRespelling(text.replace(echoed, ''));
    if (!text) return null;
    const respelling = text;
    const own = letterPairSimilarity(sentence, respelling);
    const closestToOwn = sentences.every((other, otherIndex) =>
      otherIndex === index || letterPairSimilarity(other, respelling) <= own);
    return own >= MIN_RESPELLING_SIMILARITY && closestToOwn ? respelling : null;
  });
}

/** True when no respelling can succeed for the rest of a run: the provider's balance is spent, or the key is missing or refused. */
export function respellingUnavailable(error: unknown): error is AiError {
  return error instanceof AiError && (error.kind === 'quota' || error.kind === 'auth');
}

// Respell ONE sentence into its casual spoken form (vocabulary preserved). Null when the respelling
// failed: voicing the original spelling would store a clear clip under the casual key for good.
export async function reduceToCasual(sentence: string, chat: ChatText = chatText): Promise<string | null> {
  try {
    const reply = await chat(createRequestContext(undefined, RESPELLING_BUDGET_MS), {
      system: REDUCE_SYS,
      user: sentence,
      temperature: 0.3,
      // A respelling runs about as long as its sentence; 200 tokens cut off the longer essay sentences.
      // A line cut off at max_tokens would voice only part of the sentence, so it counts as a failure.
      maxTokens: 800,
      label: 'casual respelling',
    });
    return cleanCasualRespelling(reply);
  } catch (error) {
    const failure = classifyAiError(error);
    console.warn(`[tts] casual respelling failed (${failure.kind}): ${failure.message}`);
    return null;
  }
}

// Respell MANY sentences in one chat call (batch throughput for the backfill). Returns reduced forms
// aligned 1:1 with the input; a null entry (a line that doesn't respell its sentence, or all of them when the
// reply is unusable) is respelled on its own when its clip is made. Rejects only when respelling can't work for the rest of the run: the provider's
// balance is spent or the key is missing or refused.
export async function reduceCasualBatch(sentences: string[], chat: ChatJson = chatJson): Promise<Array<string | null>> {
  if (sentences.length <= 1) return sentences.length ? [await reduceToCasual(sentences[0])] : [];
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  let reply: Record<string, unknown>;
  try {
    reply = await chat(createRequestContext(undefined, RESPELLING_BUDGET_MS), {
      system: REDUCE_BATCH_SYS,
      user: numbered,
      temperature: 0.3,
      maxTokens: 4000,
      label: 'casual respelling batch',
    });
  } catch (error) {
    if (respellingUnavailable(error)) throw error;
    const failure = classifyAiError(error);
    console.warn(`[tts] casual respelling batch failed (${failure.kind}): ${failure.message}`);
    return sentences.map(() => null);
  }
  const lines = Array.isArray(reply.lines) ? reply.lines : null;
  if (lines && lines.length === sentences.length) return acceptBatchRespellings(sentences, lines);
  console.warn(`[tts] casual respelling batch answered ${lines ? lines.length : 'no'} lines for ${sentences.length} sentences`);
  return sentences.map(() => null);
}
