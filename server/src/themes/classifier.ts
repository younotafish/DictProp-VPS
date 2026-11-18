// The theme classifier: one chat request sorts up to sixty saved words and sentences into the shared taxonomy's scenes
// (shared/item-themes.ts). The sweep (sweep.ts) runs it over the library, and a script can run it on a holdout to check
// its quality: classifyThemeBatch takes the chat client as a parameter. The whole prompt is in this file, so it can be
// tuned in one place.
import { AiError, classifyAiError, createRequestContext, type ChatJson } from '../ai-client.js';
import { isThemeId, THEME_DOMAINS } from '../shared/item-themes.js';
import { THEME_BOUNDARIES } from './boundaries.js';
import type { ThemeItem } from './input.js';

/** Items per request: a few thousand tokens of items beside the taxonomy, and a reply well inside its token cap. */
export const THEME_BATCH_SIZE = 60;
// One request's budget, its retry included.
const BATCH_BUDGET_MS = 90_000;
// An answer is about 15 tokens, so this fits sixty with room to spare; a reply cut off at the cap loses its whole
// request, whose items then go back in halves.
const MAX_REPLY_TOKENS = 2_000;
// The same items should land in the same scenes every time.
const TEMPERATURE = 0.1;

// ── The prompt ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Each scene on one line, under its domain: id | title | what it covers | where its look-alikes go instead.
const SCENE_LIST = THEME_DOMAINS.map(domain => [
  domain.title,
  ...domain.themes.map(theme => [theme.id, theme.title, theme.blurb, THEME_BOUNDARIES[theme.id] ?? ''].join(' | ')),
].join('\n')).join('\n\n');

export const THEME_SYSTEM_PROMPT = `You sort the words and sentences that a Chinese-speaking learner of American English has saved into real-life scenes, so the learner can practice saying the ones that come up together.

The scenes, grouped by domain. Each line gives: id | title | what it covers | where look-alikes go instead.

${SCENE_LIST}

For each numbered item, choose the one scene where an American would most naturally say or hear it.
- A word item is a word or phrase with the sense the learner saved and its definition ("word — sense — definition"). Place that sense only, never another meaning of the same spelling. The example words in a scene's line stand for their senses too: in another sense, a word listed there may belong elsewhere.
- A sentence item belongs to the situation the sentence shows, not to the topic of any one word in it. When it names a setting or a role that has a scene of its own (a clinic, a flight, a meeting or presentation, testimony, a restaurant, a politician, a party, a job interview, a boss managing staff, a pet), that scene wins, even when the sentence is about a smell, a slip, a verdict or a tone. Ignore framing such as "news reports said". Otherwise choose the scene of what is said or felt.
- A word for an animal's sound goes with that animal's scene.
- A general or abstract word still goes to the scene where it comes up most in everyday American life: pick the closest scene rather than leaving the item out.
- Use only the ids listed above, spelled exactly as written. Never invent an id.
- Answer every item exactly once.

Reply with JSON only, in this form: {"a":[{"i":1,"t":"scene-id"},{"i":2,"t":"scene-id"}]}, where "i" is the item's number and "t" its scene's id.`;

/** The request's items, numbered from 1, each a JSON string so its text can't rewrite the instructions. */
export function themeUserPrompt(items: readonly ThemeItem[]): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.kind} ${JSON.stringify(item.text)}`);
  return `Sort these ${items.length} items. Each comes after its number and kind, as a JSON string.\n\n${lines.join('\n')}`;
}

// ── The reply ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A reply that left items without a known scene. The chat client treats it as unusable and asks once more; when the
 * second reply falls short too, the scenes it did give still count.
 */
export class IncompleteThemeReply extends AiError {
  readonly answers: ReadonlyMap<number, string>;

  constructor(answers: ReadonlyMap<number, string>, count: number) {
    super('invalid', `The reply gave a known scene for ${answers.size} of ${count} items`);
    this.answers = answers;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The scenes a reply gives, by item number from 1 to `count`: only ids the taxonomy holds, and a number answered twice
 * with different scenes counts as unanswered.
 */
export function readThemeReply(reply: Record<string, unknown>, count: number): Map<number, string> {
  const answers = new Map<number, string>();
  const contradicted = new Set<number>();
  for (const entry of Array.isArray(reply.a) ? reply.a : []) {
    if (!isRecord(entry)) continue;
    const index = typeof entry.i === 'string' ? Number(entry.i) : entry.i;
    const themeId = typeof entry.t === 'string' ? entry.t.trim() : entry.t;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > count || !isThemeId(themeId)) continue;
    if (answers.has(index) && answers.get(index) !== themeId) contradicted.add(index);
    answers.set(index, themeId);
  }
  for (const index of contradicted) answers.delete(index);
  return answers;
}

// ── A batch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ThemeBatchResult {
  /** The scene each item got, in the order given, or null where it got none. */
  themes: Array<string | null>;
  /** The items the model left without a scene even when asked again, by position: each counts as a miss. */
  unanswered: number[];
  /** A failure of the provider or the request that ended the batch early. The items it left unasked count nothing. */
  error?: AiError;
}

export interface ThemeBatchOptions {
  /** Aborts the requests under way (the server shutting down). */
  signal?: AbortSignal;
  budgetMs?: number;
}

/**
 * Sorts up to THEME_BATCH_SIZE items into scenes. One request asks for all of them, and the chat client asks once more
 * when the reply misses some or can't be read. The items still without a scene then go back once, in requests of
 * half the batch (which also fit when a reply was cut off at its token cap) whose replies are final: the items they
 * leave out count as misses. A failure that isn't the model's answer (quota, a refused key, an unavailable service, a
 * timeout, an abort) ends the batch with the scenes it has, and the items it left unasked count nothing.
 */
export async function classifyThemeBatch(
  items: readonly ThemeItem[],
  chat: ChatJson,
  { signal, budgetMs = BATCH_BUDGET_MS }: ThemeBatchOptions = {},
): Promise<ThemeBatchResult> {
  const themes: Array<string | null> = items.map(() => null);

  /**
   * Asks for the items at these positions; the scenes given are set in `themes`. A short reply is asked again by the
   * chat client only when `whole`. Resolves the failure that stopped it, if one did.
   */
  const ask = async (positions: readonly number[], whole: boolean): Promise<AiError | undefined> => {
    let answers: ReadonlyMap<number, string>;
    try {
      answers = await chat(createRequestContext(signal, budgetMs), {
        system: THEME_SYSTEM_PROMPT,
        user: themeUserPrompt(positions.map(position => items[position])),
        maxTokens: MAX_REPLY_TOKENS,
        temperature: TEMPERATURE,
        label: 'theme classifier',
        accept: (reply) => {
          const given = readThemeReply(reply, positions.length);
          if (whole && given.size < positions.length) throw new IncompleteThemeReply(given, positions.length);
          return given;
        },
      });
    } catch (error) {
      const failure = classifyAiError(error, signal);
      if (failure instanceof IncompleteThemeReply) answers = failure.answers;
      // A reply that couldn't be read, or was cut off, answered nothing.
      else if (failure.kind === 'invalid' || failure.kind === 'truncated') answers = new Map();
      else return failure;
    }
    for (const [number, themeId] of answers) themes[positions[number - 1]] = themeId;
    return undefined;
  };

  if (items.length === 0) return { themes, unanswered: [] };
  const error = await ask(items.map((_item, position) => position), true);
  if (error) return { themes, unanswered: [], error };

  const missing = themes.flatMap((themeId, position) => (themeId === null ? [position] : []));
  const half = Math.ceil(items.length / 2);
  const unanswered: number[] = [];
  for (let start = 0; start < missing.length; start += half) {
    const positions = missing.slice(start, start + half);
    const retryError = await ask(positions, false);
    if (retryError) return { themes, unanswered, error: retryError };
    unanswered.push(...positions.filter(position => themes[position] === null));
  }
  return { themes, unanswered };
}
