/**
 * What a study prompt shows, and how a typed answer compares with the card. Pure text work, so the study session
 * (services/studySession.ts) and the card (components/study/StudyCard.tsx) share one version of it.
 */

import { stripSentenceMarkers } from './sentenceMarkers';
import { normalizeKey, splitForms } from './wordMatch';
import type { StudyContent, StudyTaskType } from './studySession';

/** What each study task asks, shown in the card's header. */
export const TASK_INSTRUCTIONS: Record<StudyTaskType, string> = {
  meaning: 'Recall the meaning',
  production: 'Type the English word',
  cloze: 'Fill in the blank',
  listening: 'Listen to the sentence',
};

const PART_OF_SPEECH = /^(phrasal verb|noun|verb|adjective|adverb|idiom)\b/i;

/** The part of speech a sense label starts with ('noun: emotion' -> 'noun'), or '' if it starts with no known one. */
export function partOfSpeechOf(sense?: string): string {
  return sense?.trim().match(PART_OF_SPEECH)?.[1].toLowerCase() ?? '';
}

/** The sentence with the studied word blanked out: its {{marked}} form when there is one, else the word itself. */
export function createClozePrompt(sentence: string, word: string): string {
  const markedCloze = (sentence || '').replace(/\{\{(.+?)\}\}/g, '_____');
  const plain = stripSentenceMarkers(markedCloze);
  if (plain.includes('_____')) return plain;
  if (!word.trim()) return plain;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return plain.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '_____');
}

/**
 * The example a cloze or listening prompt uses, taking turns through the card's examples (blank ones skipped) as
 * its reviews add up, so the learner remembers the word rather than one sentence. selectReviewTask alternates cloze
 * and listening by the parity of totalReviews, so each example serves two reviews: with two examples, cloze and
 * listening each go through both, instead of cloze always getting the first and listening the second.
 */
export function pickExample(examples: readonly string[] | undefined, totalReviews: number): string {
  const usable = (examples ?? []).filter(example => typeof example === 'string' && example.trim() !== '');
  if (usable.length === 0) return '';
  const reviews = Number.isFinite(totalReviews) && totalReviews > 0 ? totalReviews : 0;
  return usable[Math.floor(reviews / 2) % usable.length];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with the word and each of its listed forms blanked out wherever they stand as whole words, in any case and
 * longest first, so a definition written before the 2026-09-29 prompt rule can't give the answer away. The word goes
 * as spelled and as keyed (normalizeKey: 'teacher's' -> 'teacher'), the forms as keyed. A key of one character other
 * than the word itself is left alone: a stray '-s' among the forms would otherwise blank the s of every "it's".
 */
export function maskAnswer(text: string, word: string, forms?: string[]): string {
  if (!text) return text;
  const targets = new Set([normalizeKey(word), ...splitForms(forms)].filter(key => key.length > 1));
  const spelled = word.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (spelled) targets.add(spelled);
  if (targets.size === 0) return text;
  const alternatives = [...targets]
    .sort((a, b) => b.length - a.length)
    .map(target => escapeRegExp(target).replace(/ /g, '\\s+').replace(/'/g, "['’]"));
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), '_____');
}

/** What a prompt shows above the answer box or the answer. */
export interface StudyPromptText {
  /** The word, the masked Chinese (or definition) of a production prompt, the cloze sentence, or '' for listening. */
  text: string;
  /** Under a meaning prompt for a spelling with several senses: 'noun · one of 3 meanings'. */
  sub?: string;
  /** Under a production prompt that shows the Chinese: the English definition, masked. */
  detail?: string;
  /** The word is a phrase, which takes a smaller size. */
  multiWord: boolean;
}

/**
 * The prompt for `task`. A meaning prompt for one of several senses of a spelling (`siblingCount` of them in the
 * study list) says which of how many, with the part of speech when the sense label gives one. A production prompt
 * shows the Chinese with the English definition beneath it, the word and its forms masked in both.
 */
export function studyPrompt(content: StudyContent, task: StudyTaskType, siblingCount: number): StudyPromptText {
  const multiWord = /\s/.test(content.word.trim());
  if (task === 'meaning') {
    if (siblingCount < 2) return { text: content.word, multiWord };
    const partOfSpeech = partOfSpeechOf(content.sense);
    return { text: content.word, sub: `${partOfSpeech ? `${partOfSpeech} · ` : ''}one of ${siblingCount} meanings`, multiWord };
  }
  if (task === 'production') {
    const definition = maskAnswer(content.definition, content.word, content.forms);
    if (!content.chinese) return { text: definition, multiWord };
    const chinese = maskAnswer(content.chinese, content.word, content.forms);
    return definition ? { text: chinese, detail: definition, multiWord } : { text: chinese, multiWord };
  }
  if (task === 'cloze') return { text: createClozePrompt(content.example, content.word), multiWord };
  return { text: '', multiWord };
}

/** How a typed answer compares with the card. It never grades: the learner still does. */
export type TypedAnswerVerdict =
  | { kind: 'empty' }
  | { kind: 'correct' | 'synonym' | 'wrong'; typed: string }
  | { kind: 'typo'; typed: string; distance: number };

/** Edits (an insertion, a deletion, a substitution, or two neighbours swapped) from `a` to `b`: optimal string alignment. */
function editDistance(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  const d = Array.from({ length: s.length + 1 }, (_, i) => Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[s.length][t.length];
}

/** The edits a misspelling of `target` may have: none under 4 letters, one up to 7, two from 8. */
const allowedEdits = (target: string) => (target.length >= 8 ? 2 : target.length >= 4 ? 1 : 0);

/**
 * How a typed answer compares with the card, ignoring case, spacing and edge punctuation: the word or one of its
 * listed forms is correct; one of its synonyms is a synonym; the word or a form misspelled within allowedEdits is a
 * typo; anything else is wrong. The answer shown back is the one typed, trimmed.
 */
export function judgeTypedAnswer(
  typed: string,
  card: { word: string; forms?: string[]; synonyms?: string[] },
): TypedAnswerVerdict {
  const key = normalizeKey(typed);
  if (!key) return { kind: 'empty' };
  const shown = typed.trim();
  const targets = [normalizeKey(card.word), ...splitForms(card.forms)].filter(Boolean);
  if (targets.includes(key)) return { kind: 'correct', typed: shown };
  if ((card.synonyms ?? []).some(synonym => typeof synonym === 'string' && normalizeKey(synonym) === key)) {
    return { kind: 'synonym', typed: shown };
  }
  let closest = Infinity;
  for (const target of targets) {
    const distance = editDistance(key, target);
    if (distance <= allowedEdits(target)) closest = Math.min(closest, distance);
  }
  return Number.isFinite(closest) ? { kind: 'typo', typed: shown, distance: closest } : { kind: 'wrong', typed: shown };
}

/** The line under a revealed answer that says how the typed answer compares, and its tone; null when nothing was typed. */
export function verdictLine(verdict: TypedAnswerVerdict, word: string): { text: string; tone: 'correct' | 'close' | 'wrong' } | null {
  switch (verdict.kind) {
    case 'empty': return null;
    case 'correct': return { text: `✓ ${verdict.typed}`, tone: 'correct' };
    case 'typo': return { text: `≈ ${verdict.typed} — ${verdict.distance === 1 ? 'one letter' : 'two letters'} off`, tone: 'close' };
    case 'synonym': return { text: `↔ ${verdict.typed} is a synonym — this card is ${word}`, tone: 'close' };
    case 'wrong': return { text: `✗ ${verdict.typed}`, tone: 'wrong' };
  }
}
