import { isSentenceItem, isVocabItem, type SentenceData, type StoredItem } from '../../types';
import { stripSentenceMarkers } from '../sentenceMarkers';
import { connectedSpeechIpa } from '../sentencePronunciation';
import { sentenceSourceResolver } from '../sentenceSource';
import { normalizeKey, splitForms } from '../wordMatch';
import { sentenceTranslation } from './standing';

// What Today shows for a sentence: the cue that asks for it, the one hint an attempt may take, and the answer the
// reveal shows. The answer is always the whole sentence, never a single word. Data only; the Today screen renders it.
// A cue gets harder as the memory does: level 1 shows the translation and the studied expression to use until the
// sentence has been reviewed and its stability reaches CUE_LEVEL_TWO_STABILITY days; level 2 shows the translation and
// the picture from then on. Meeting a sentence in a set is always level 1.

/** Today's two ways of practicing: saying the sentence aloud, or thinking it silently (Quiet, which can't graduate). */
export type LoopMode = 'speak' | 'quiet';

/** Days of stability from which a sentence's cue moves to level 2. */
const CUE_LEVEL_TWO_STABILITY = 6;

/** A stretch of a sentence: plain text, or the studied expression (`target`), which the answer marks. */
export interface TextPart {
  text: string;
  target: boolean;
}

/** What the cue shows: the translation (large), and at level 1 the expression to use, or at level 2 the picture. */
export type LoopCue = {
  kind: 'sentence';
  level: 1 | 2;
  translation: string;
  /** Level 1: the studied expression to use (the sentence's sourceWord as saved, trimmed), when the sentence holds it. */
  expression?: string;
  /** Level 2: the sentence's picture, when it has one. */
  imageUrl?: string;
};

/** The one hint an attempt may take: the first letter of each word of the whole sentence ('H__ w__ y___ w______?'). */
export type LoopHint = { kind: 'letters'; text: string };

/** What the reveal shows. */
export interface LoopAnswer {
  /** The sentence cut around its studied expression (markExpression), else the whole sentence unmarked. */
  parts: TextPart[];
  /** The plain sentence, as speech plays it and its clip is keyed. */
  text: string;
  translation: string;
  /** Connected-speech IPA, when the analysis has it. */
  ipa?: string;
}

/** A sentence as Today shows it in one mode: the cue and its prompt, what counts, the hint, and the answer. */
export interface LoopCard {
  cue: LoopCue;
  /** The line above the cue: 'Say the whole sentence', or 'Think of the whole sentence' in Quiet. */
  prompt: string;
  /** Under the cue: what counts as saying it (WHAT_COUNTS). */
  note: string;
  hint: LoopHint;
  answer: LoopAnswer;
}

const PROMPTS: Record<LoopMode, string> = {
  speak: 'Say the whole sentence',
  quiet: 'Think of the whole sentence',
};

/**
 * What counts as saying a sentence, which the Meet's Can say it and a run's Got it both claim: the whole sentence, its
 * expression exact when the answer marks one.
 */
export const WHAT_COUNTS = {
  expression: 'The whole sentence, the expression exact; small slips are fine',
  plain: 'The whole sentence; small slips are fine',
} as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The word and its forms as maskAnswer (services/studyPrompt.ts) finds them: whole words in any case, longest first, the
 * word as spelled and as keyed, the forms as keyed, and no key of one character but the word itself. Null with nothing
 * to look for.
 */
function answerPattern(word: string, forms: string[] | undefined): RegExp | null {
  const targets = new Set([normalizeKey(word), ...splitForms(forms)].filter(key => key.length > 1));
  const spelled = word.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (spelled) targets.add(spelled);
  if (targets.size === 0) return null;
  const alternatives = [...targets]
    .sort((a, b) => b.length - a.length)
    .map(target => escapeRegExp(target).replace(/ /g, '\\s+').replace(/'/g, "['’]"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

/** `text` cut at each match of `pattern`, the matches as targets. */
function splitAt(text: string, pattern: RegExp, group: number): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), target: false });
    parts.push({ text: match[group], target: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), target: false });
  return parts;
}

/**
 * A sentence cut around its studied expression: the {{marked}} part when it has one, else the word or its forms at word
 * boundaries in any case (as maskAnswer finds them), every occurrence. [[Lookup]] marks become plain text and
 * punctuation stays. Null when no expression can be found.
 */
export function markExpression(text: string, word: string, forms?: string[]): TextPart[] | null {
  const plain = (text || '').replace(/\[\[(.+?)\]\]/g, '$1');
  if (/\{\{.+?\}\}/.test(plain)) return splitAt(plain, /\{\{(.+?)\}\}/g, 1);
  const pattern = answerPattern(word || '', forms);
  const parts = pattern ? splitAt(plain, pattern, 0) : [];
  return parts.some(part => part.target) ? parts : null;
}

/**
 * Each word's first letter, its other letters as '_' ('How was your weekend?' -> 'H__ w__ y___ w______?').
 * Apostrophes, hyphens, digits and punctuation show as they are, so the shape of the answer does too.
 */
export function firstLetters(text: string): string {
  return text.normalize('NFC').replace(/\p{L}[\p{L}\p{M}'’]*/gu, word => {
    const [first, ...rest] = [...word];
    return first + rest.map(char => (/[\p{L}\p{M}]/u.test(char) ? '_' : char)).join('');
  });
}

/**
 * The cue level a sentence's schedule earns: 1 until it has been reviewed and its stability has reached six days, 2
 * from then on. The Meet asks at level 1 whatever this says (loopCard's `level`), however strong Got it made a sentence.
 */
export function cueLevel(item: StoredItem): 1 | 2 {
  const srs = item.srs;
  return Number(srs?.totalReviews) > 0 && Number(srs?.stability) >= CUE_LEVEL_TWO_STABILITY ? 2 : 1;
}

/**
 * The expression a level 1 cue asks to be used, once markExpression has found it in the sentence (`parts`): the source
 * word as saved, trimmed, or, for a sentence without one, its {{marked}} text (separate marks joined by ' … ').
 * Undefined when the sentence holds no expression.
 */
function expressionToUse(data: SentenceData, parts: readonly TextPart[] | null): string | undefined {
  if (!parts) return undefined;
  const source = (data.sourceWord || '').trim();
  if (source) return source;
  const marked = parts.filter(part => part.target).map(part => part.text.trim()).filter(Boolean);
  return marked.length > 0 ? marked.join(' … ') : undefined;
}

/**
 * Each sentence's source-card forms (the card services/sentenceSource.ts finds for its word and sense), from a lookup
 * built once over the library; undefined for a word card or a sentence whose word has no card.
 */
export function sourceFormsLookup(items: readonly StoredItem[]): (item: StoredItem) => string[] | undefined {
  const sourceOf = sentenceSourceResolver(items);
  return item => {
    if (!isSentenceItem(item)) return undefined;
    const source = sourceOf(item.data.sourceWord, item.data.sourceSense);
    return source && isVocabItem(source) ? source.data.forms : undefined;
  };
}

/**
 * A saved sentence as Today shows it in `mode`, its cue at `level` (cueLevel's by default; the Meet passes 1). Its
 * expression is its {{marked}} part, else its source word or that word's forms, which come from the source card
 * (`sourceForms`, sourceFormsLookup).
 */
export function loopCard(item: StoredItem, mode: LoopMode, sourceForms?: string[], level: 1 | 2 = cueLevel(item)): LoopCard {
  const data = item.data as SentenceData;
  const translation = sentenceTranslation(data);
  const parts = markExpression(data.text, data.sourceWord, sourceForms);
  const text = stripSentenceMarkers(data.text);
  const ipa = connectedSpeechIpa(data.analysis);
  const expression = level === 1 ? expressionToUse(data, parts) : undefined;
  const cue: LoopCue = level === 1
    ? { kind: 'sentence', level, translation, ...(expression ? { expression } : {}) }
    : { kind: 'sentence', level, translation, ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}) };
  return {
    cue,
    prompt: PROMPTS[mode],
    note: parts ? WHAT_COUNTS.expression : WHAT_COUNTS.plain,
    hint: { kind: 'letters', text: firstLetters(text) },
    answer: { parts: parts ?? [{ text, target: false }], text, translation, ...(ipa ? { ipa } : {}) },
  };
}
