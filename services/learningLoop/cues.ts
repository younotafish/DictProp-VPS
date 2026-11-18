import { isSentenceItem, isVocabItem, type SentenceData, type StoredItem, type VocabCard } from '../../types';
import { stripSentenceMarkers } from '../sentenceMarkers';
import { connectedSpeechIpa } from '../sentencePronunciation';
import { sentenceSourceResolver } from '../sentenceSource';
import { maskAnswer, partOfSpeechOf } from '../studyPrompt';
import { normalizeKey, splitForms } from '../wordMatch';
import { sentenceTranslation } from './standing';

// What Today shows for an item: the cue that asks for the English, the one hint an attempt may take, and the answer the
// reveal shows. Data only; the Today screen renders it. A cue gets harder as the memory does: level 1 while the item is
// new or its stability is under CUE_LEVEL_TWO_STABILITY days (meeting an item in a set is always level 1), level 2 from
// then on.

/** Today's two ways of practicing: saying the English aloud, or thinking it silently (Quiet, which can't graduate). */
export type LoopMode = 'speak' | 'quiet';

/** Days of stability from which an item's cue moves to level 2. */
export const CUE_LEVEL_TWO_STABILITY = 6;

/** A stretch of a sentence: plain text, or the studied expression (`target`), which a cue blanks and an answer marks. */
export interface TextPart {
  text: string;
  target: boolean;
}

/** What the cue shows. `imageUrl` is the item's picture reference, present when the cue shows a picture and it has one. */
export type LoopCue =
  /** The Chinese (large), the definition with the word and its forms blanked, the part of speech, the picture. */
  | { kind: 'word'; level: 1; chinese: string; definition: string; partOfSpeech: string; imageUrl?: string }
  /** One of the card's examples with the word blanked, and the Chinese. */
  | { kind: 'word'; level: 2; chinese: string; example: TextPart[] }
  /** The translation (large) and the sentence with its studied expression blanked. */
  | { kind: 'sentence'; level: 1; translation: string; sentence: TextPart[] }
  /** The translation and the picture only. */
  | { kind: 'sentence'; level: 2; translation: string; imageUrl?: string };

/** The one hint an attempt may take: the answer's first letters ('c___ d___ w___'), or the sentence as a cloze. */
export type LoopHint = { kind: 'letters'; text: string } | { kind: 'cloze'; parts: TextPart[] };

/** What the reveal shows. `text` is the plain sentence, as speech plays it and its clip is keyed. */
export type LoopAnswer =
  | {
    kind: 'word';
    word: string;
    ipa: string;
    sense: string;
    chinese: string;
    definition: string;
    /** The level 2 cue's example, else the card's first; absent when it has none. */
    example?: { parts: TextPart[]; text: string };
  }
  | { kind: 'sentence'; parts: TextPart[]; text: string; translation: string; /** Connected-speech IPA, when known. */ ipa?: string };

/** An item as Today shows it in one mode: the cue and its prompt, the hint, and the answer. */
export interface LoopCard {
  cue: LoopCue;
  /** The line above the cue: 'Say the word', or 'Think of the word' in Quiet. */
  prompt: string;
  /** Under a sentence's level 1 prompt: what counts as Got it. */
  note?: string;
  hint: LoopHint;
  answer: LoopAnswer;
}

const PROMPTS: Record<LoopMode, Record<'word' | 'wordSentence' | 'sentence' | 'sentenceFromMeaning', string>> = {
  speak: {
    word: 'Say the word',
    wordSentence: 'Say the sentence',
    sentence: 'Say the whole sentence',
    sentenceFromMeaning: 'Say it in English with the expression',
  },
  quiet: {
    word: 'Think of the word',
    wordSentence: 'Think of the sentence',
    sentence: 'Think of the whole sentence',
    sentenceFromMeaning: 'Think of it in English with the expression',
  },
};

/** What Got it means for a sentence said from its cloze. */
export const SENTENCE_GOT_IT_RULE = 'Got it = the expression exactly, the rest in your own words';

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
 * boundaries in any case (as maskAnswer finds them), every occurrence, so none gives the answer away. [[Lookup]] marks
 * become plain text and punctuation stays. Null when no expression can be found.
 */
export function markExpression(text: string, word: string, forms?: string[]): TextPart[] | null {
  const plain = (text || '').replace(/\[\[(.+?)\]\]/g, '$1');
  if (/\{\{.+?\}\}/.test(plain)) return splitAt(plain, /\{\{(.+?)\}\}/g, 1);
  const pattern = answerPattern(word || '', forms);
  const parts = pattern ? splitAt(plain, pattern, 0) : [];
  return parts.some(part => part.target) ? parts : null;
}

/** The parts as a cue shows them, each target a blank. */
export const clozeText = (parts: readonly TextPart[]): string => parts.map(part => (part.target ? '_____' : part.text)).join('');

/**
 * Each word's first letter, its other letters as '_' ('come down with' -> 'c___ d___ w___'). Apostrophes, hyphens,
 * digits and punctuation show as they are, so the shape of the answer does too.
 */
export function firstLetters(text: string): string {
  return text.normalize('NFC').replace(/\p{L}[\p{L}\p{M}'’]*/gu, word => {
    const [first, ...rest] = [...word];
    return first + rest.map(char => (/[\p{L}\p{M}]/u.test(char) ? '_' : char)).join('');
  });
}

/** The cue level for an item: 1 while it is new or its stability is under six days, else 2. */
export function cueLevel(item: StoredItem): 1 | 2 {
  const srs = item.srs;
  return Number(srs?.totalReviews) > 0 && Number(srs?.stability) >= CUE_LEVEL_TWO_STABILITY ? 2 : 1;
}

/** A card's examples that a cue can blank the word in, as parts, blank ones left out. */
function blankableExamples(card: VocabCard): TextPart[][] {
  const examples: TextPart[][] = [];
  for (const example of card.examples ?? []) {
    if (typeof example !== 'string' || !example.trim()) continue;
    const parts = markExpression(example, card.word, card.forms);
    if (parts) examples.push(parts);
  }
  return examples;
}

function wordCard(item: StoredItem, card: VocabCard, mode: LoopMode): LoopCard {
  const chinese = maskAnswer(card.chinese ?? '', card.word, card.forms);
  const hint: LoopHint = { kind: 'letters', text: firstLetters(card.word.trim()) };
  const answer = (example?: TextPart[]): LoopAnswer => {
    const first = (card.examples ?? []).find(text => typeof text === 'string' && text.trim() !== '');
    const parts = example ?? (first ? markExpression(first, card.word, card.forms) ?? [{ text: stripSentenceMarkers(first), target: false }] : undefined);
    return {
      kind: 'word',
      word: card.word.trim(),
      ipa: card.ipa ?? '',
      sense: card.sense ?? '',
      chinese: card.chinese ?? '',
      definition: card.definition ?? '',
      ...(parts ? { example: { parts, text: parts.map(part => part.text).join('') } } : {}),
    };
  };
  if (cueLevel(item) === 2) {
    // The examples take turns, one more each review, so the word is recalled rather than one sentence.
    const examples = blankableExamples(card);
    if (examples.length > 0) {
      const example = examples[(item.srs?.totalReviews ?? 0) % examples.length];
      return { cue: { kind: 'word', level: 2, chinese, example }, prompt: PROMPTS[mode].wordSentence, hint, answer: answer(example) };
    }
  }
  return {
    cue: {
      kind: 'word',
      level: 1,
      chinese,
      definition: maskAnswer(card.definition ?? '', card.word, card.forms),
      partOfSpeech: partOfSpeechOf(card.sense),
      ...(card.imageUrl ? { imageUrl: card.imageUrl } : {}),
    },
    prompt: PROMPTS[mode].word,
    hint,
    answer: answer(),
  };
}

function sentenceCard(item: StoredItem, data: SentenceData, mode: LoopMode, sourceForms: string[] | undefined): LoopCard {
  const translation = sentenceTranslation(data);
  const expression = markExpression(data.text, data.sourceWord, sourceForms);
  const plain = stripSentenceMarkers(data.text);
  const ipa = connectedSpeechIpa(data.analysis);
  const answer: LoopAnswer = {
    kind: 'sentence',
    parts: expression ?? [{ text: plain, target: false }],
    text: plain,
    translation,
    ...(ipa ? { ipa } : {}),
  };
  // Without an expression to blank there is no level 1 cue: the translation alone asks for the sentence.
  if (cueLevel(item) === 1 && expression) {
    const targets = expression.filter(part => part.target).map(part => firstLetters(part.text));
    return {
      cue: { kind: 'sentence', level: 1, translation, sentence: expression },
      prompt: PROMPTS[mode].sentence,
      note: SENTENCE_GOT_IT_RULE,
      hint: { kind: 'letters', text: targets.join(' … ') },
      answer,
    };
  }
  return {
    cue: { kind: 'sentence', level: 2, translation, ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}) },
    prompt: PROMPTS[mode].sentenceFromMeaning,
    hint: expression ? { kind: 'cloze', parts: expression } : { kind: 'letters', text: firstLetters(plain) },
    answer,
  };
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
 * The item as Today shows it in `mode`: a word card, or a saved sentence. A sentence's expression is its {{marked}}
 * part, else its source word or that word's forms, which come from the source card (`sourceForms`, sourceFormsLookup).
 */
export function loopCard(item: StoredItem, mode: LoopMode, sourceForms?: string[]): LoopCard {
  return isVocabItem(item)
    ? wordCard(item, item.data, mode)
    : sentenceCard(item, item.data as SentenceData, mode, sourceForms);
}
