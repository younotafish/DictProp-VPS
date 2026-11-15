// Casual "style" track.
// A second rendition of each sentence in fast, reduced, movie-like speech. The cache "voice" field
// doubles as a STYLE token: any MiMo voice name (e.g. 'Mia') = the clear track; the CASUAL_STYLE
// sentinel = the casual recipe below. The clip is keyed by (style, ORIGINAL sentence) — so the
// client finds it from the on-screen text — while the AUDIO is a phonetically-reduced respelling the
// AI produces (e.g. "reaching"->"reachin'", "to him"->"ta 'im"). Vocabulary words are preserved; only
// pronunciation changes. Both clear and casual clips receive locally generated word timings.
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import { GEN_TIMEOUT_MS } from './synthesis.js';

const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const REDUCE_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
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

async function postLargeJson(url: string, body: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
  try {
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    return response.ok ? await response.text() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// The model sometimes wraps its line in quotes: strip one wrapping pair of double quotes (straight or
// curly). Apostrophes ARE the respelling ("'cause", "goin'") and must survive. Null when nothing is left.
export function cleanCasualRespelling(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const wrapped = /^["\u201c\u201d]([\s\S]*)["\u201c\u201d]$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  return text || null;
}

// Respell ONE sentence into its casual spoken form (vocabulary preserved). Null when the respelling
// failed: voicing the original spelling would store a clear clip under the casual key for good.
export async function reduceToCasual(sentence: string): Promise<string | null> {
  const body = JSON.stringify({
    model: REDUCE_MODEL,
    messages: [{ role: 'system', content: REDUCE_SYS }, { role: 'user', content: sentence }],
    temperature: 0.3,
    // A respelling runs about as long as its sentence; 200 tokens cut off the longer essay sentences.
    max_tokens: 800,
  });
  const raw = await postLargeJson(CHAT_URL, body);
  if (!raw) return null;
  try {
    const choice: any = JSON.parse(raw)?.choices?.[0];
    // A line cut off at max_tokens would voice only part of the sentence.
    if (choice?.finish_reason === 'length') return null;
    return cleanCasualRespelling(choice?.message?.content);
  } catch {
    return null;
  }
}

// Respell MANY sentences in one chat call (batch throughput for the backfill). Returns reduced forms
// aligned 1:1 with the input (null where one failed); on any count mismatch / parse failure, falls back
// to per-sentence reduce.
export async function reduceCasualBatch(sentences: string[]): Promise<Array<string | null>> {
  if (sentences.length <= 1) return sentences.length ? [await reduceToCasual(sentences[0])] : [];
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const sys = REDUCE_SYS + ' You will receive a numbered list; respond with JSON {"lines":[...]} ' +
    'containing one respelled line per input, in the SAME order and the SAME count.';
  const body = JSON.stringify({
    model: REDUCE_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
  });
  const raw = await postLargeJson(CHAT_URL, body);
  try {
    const data: any = JSON.parse(raw);
    let content: any = data?.choices?.[0]?.message?.content ?? '';
    if (typeof content === 'string') content = JSON.parse(content);
    const lines = Array.isArray(content?.lines) ? content.lines : null;
    if (lines && lines.length === sentences.length) {
      return lines.map((line: unknown) => cleanCasualRespelling(line));
    }
  } catch {
    /* fall through to per-sentence */
  }
  const out: Array<string | null> = [];
  for (const s of sentences) out.push(await reduceToCasual(s));
  return out;
}
