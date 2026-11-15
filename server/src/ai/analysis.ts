// Generating an analysis: one model answer, targeted repairs of the cards that fail validation, and at most one
// full re-ask, all inside the request's budget.
import {
  AiError,
  classifyAiError,
  remainingMs,
  type AiRequestContext,
  type ChatJson,
} from '../ai-client.js';
import {
  normalizeAnalysisResponse,
  normalizeVocabCard,
  sortVocabsByUsage,
  vocabValidationIssues,
} from '../ai-response.js';
import { isWordOrPhrase } from '../shared/query-mode.js';
import {
  analysisPrompts,
  MAX_CARDS_PER_HEADWORD,
  reaskFeedback,
  repairPrompts,
  TRUNCATION_FEEDBACK,
  type AnalysisMode,
} from './prompts.js';
import { trimmedString } from './sanitize.js';

const ANALYSIS_MAX_TOKENS = 16_000;
const REPAIR_MAX_TOKENS = 12_000;
const REPAIR_TEMPERATURE = 0.3;

// A full answer is re-asked once at most (after a cut-off reply or when nothing usable came back),
// and only while a whole generation can still fit in the budget.
const MAX_ANALYSIS_ATTEMPTS = 2;
const MIN_ANALYSIS_ATTEMPT_WINDOW_MS = 60_000;
// Failing cards get up to two targeted repair rounds; a repair rewrites only those cards, so it is shorter.
const MAX_REPAIR_ROUNDS = 2;
const MIN_REPAIR_WINDOW_MS = 20_000;

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** How one analysis request is answered, decided once for the log line, the prompt and the response. */
export interface QueryRoute {
  /** The input, trimmed. */
  query: string;
  mode: AnalysisMode;
  /** One dictionary entry (a word, phrase or batch item) rather than a sentence. */
  isWord: boolean;
  /** The input as typed when it contains Chinese, so the client can show what was asked. */
  originalQuery?: string;
}

export function routeQuery(text: string, mode: unknown): QueryRoute {
  // A batch item was picked out by a vocabulary scan, so it is always one entry, however it reads.
  const isBatch = mode === 'batch';
  const isWord = isBatch || isWordOrPhrase(text);
  return {
    query: text.trim(),
    mode: isBatch ? 'batch' : isWord ? 'word' : 'sentence',
    isWord,
    originalQuery: containsChinese(text) ? text : undefined,
  };
}

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
    ...repairPrompts(headword, failing),
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

export interface AnalysisResult {
  data: any;
  /** The headword or sentence the model analyzed (the English it chose for a Chinese input). */
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
  route: QueryRoute,
): Promise<AnalysisResult> {
  const { query, isWord } = route;
  const prompts = analysisPrompts(query, route.mode);
  let feedback = '';
  let lastFailure: AiError | undefined;

  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
    if (attempt > 1 && remainingMs(ctx) < MIN_ANALYSIS_ATTEMPT_WINDOW_MS) {
      console.warn(`Analysis: ${remainingMs(ctx)}ms left, too little for another full attempt`);
      break;
    }
    let modelData: Record<string, any>;
    try {
      modelData = await chat(ctx, { system: prompts.system, user: prompts.user + feedback, maxTokens: ANALYSIS_MAX_TOKENS, label: `analysis ${attempt}` });
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
    if (usable) return { data, resolvedQuery: data.query || query };

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
