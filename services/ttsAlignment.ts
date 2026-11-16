/**
 * Maps a clicked word's character offset (within the STRIPPED sentence) to a playback time,
 * using the per-word timings the server produced (whisper word-alignment of the cached clip).
 *
 * The timings come from transcribing the synthesized audio, so a word's TEXT may be misheard, split, merged or
 * dropped — but its START time is still correct. Each timing word anchors only where it stands as a whole word in
 * the stripped sentence (so a misheard "a" can't anchor inside "hat"), keeping the words in order and anchoring as
 * many as that order allows, each at its nearest such place: a misheard word that also occurs later in the sentence
 * isn't anchored there when that would leave the words in between without anchors. A timing word that is the first
 * letters of the word that comes next ("can" of "cannot", "runnin'" of "running") anchors at that word. A word that
 * can't be placed (misheard, an expanded number, punctuation) gets no anchor, and a click on it resolves to the
 * nearest earlier anchor. This degrades gracefully and never throws.
 */
import type { WordTiming } from './api/tts';

export interface AlignedWord { charOffset: number; startTime: number }

const isPunctOnly = (s: string): boolean => /^[^\p{L}\p{N}]+$/u.test(s);
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Every offset where `token` stands in `text` as a whole word, in order. A token's edge that is punctuation (the
 *  apostrophe of "'t", say) needs no boundary next to it. */
const wholeWordOffsets = (text: string, token: string): number[] => {
  const needsStart = isWordChar(token[0]);
  const needsEnd = isWordChar(token[token.length - 1]);
  const offsets: number[] = [];
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    if (needsStart && isWordChar(text[at - 1])) continue;
    if (needsEnd && isWordChar(text[at + token.length])) continue;
    offsets.push(at);
  }
  return offsets;
};

/** The span of the first word that starts at or after `from`, or null when no word does. */
const nextWord = (text: string, from: number): { start: number; end: number } | null => {
  let start = from;
  while (start < text.length && !(isWordChar(text[start]) && !isWordChar(text[start - 1]))) start++;
  if (start >= text.length) return null;
  let end = start;
  while (end < text.length && isWordChar(text[end])) end++;
  return { start, end };
};

/** Whether `token`, less a trailing apostrophe or other mark, is the first two or more letters of `word`. */
const beginsWord = (token: string, word: string): boolean => {
  const letters = token.replace(/[^\p{L}\p{N}]+$/u, '');
  return isWordChar(token[0]) && letters.length >= 2 && word.startsWith(letters);
};

/** Build [{charOffset, startTime}] anchors, in sentence order, for the timing words that can be placed. */
export const alignWordsToStripped = (stripped: string, words: WordTiming[] | null | undefined): AlignedWord[] => {
  if (!stripped || !words || !words.length) return [];
  const lower = stripped.toLowerCase();
  const tokens = words
    .map(w => ({ text: (w?.text || '').trim().toLowerCase(), startTime: w?.start }))
    .filter(token => token.text && !isPunctOnly(token.text));
  const length = lower.length;
  // nextAt[i][p]: the nearest offset at or after p where token i stands as a whole word, or -1.
  const nextAt = tokens.map(({ text }) => {
    const offsets = new Set(wholeWordOffsets(lower, text));
    const next = new Int32Array(length + 2).fill(-1);
    for (let p = length; p >= 0; p--) next[p] = offsets.has(p) ? p : next[p + 1];
    return next;
  });
  // most[i][p]: how many of tokens i… can anchor at whole words, in order, from offset p on.
  const most = Array.from({ length: tokens.length + 1 }, () => new Int32Array(length + 2));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const size = tokens[i].text.length;
    for (let p = length; p >= 0; p--) {
      const at = nextAt[i][p];
      most[i][p] = at === -1 ? most[i + 1][p] : Math.max(most[i + 1][p], 1 + most[i + 1][at + size]);
    }
  }

  // Walk the tokens in order. Each anchors at its nearest whole-word place whenever that still lets the most tokens
  // anchor (a tie goes to anchoring it); one that doesn't may anchor at the next word, if it begins that word and
  // giving up the word costs the tokens after it no anchor.
  const out: AlignedWord[] = [];
  let from = 0;
  tokens.forEach(({ text, startTime }, i) => {
    const rest = most[i + 1];
    const at = nextAt[i][from];
    if (at !== -1 && 1 + rest[at + text.length] >= rest[from]) {
      out.push({ charOffset: at, startTime });
      from = at + text.length;
      return;
    }
    const word = nextWord(lower, from);
    if (word && beginsWord(text, lower.slice(word.start, word.end)) && rest[word.end] === rest[from]) {
      out.push({ charOffset: word.start, startTime });
      from = word.end;
    }
  });
  return out;
};

/** Nearest anchor with charOffset <= clickedOffset → its start time. Null when there are no anchors. */
export const seekTimeForOffset = (aligned: AlignedWord[], clickedOffset: number): number | null => {
  if (!aligned.length) return null;
  let lo = 0, hi = aligned.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (aligned[mid].charOffset <= clickedOffset) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans === -1 ? aligned[0].startTime : aligned[ans].startTime;
};

/**
 * Where to start a clip of `text` to play from the word at `offset`, a character index in `text` as shown (markers
 * stripped, leading spaces kept, as HighlightedSentence's data-word-offset counts). The timings belong to the clip of
 * the trimmed text, so the offset loses the leading spaces first. Null without timings or anchors.
 */
export const startAtForOffset = (text: string, timings: WordTiming[] | null | undefined, offset: number): number | null => {
  const stripped = text.trim();
  const leading = text.length - text.trimStart().length;
  return seekTimeForOffset(alignWordsToStripped(stripped, timings), Math.max(0, offset - leading));
};

// MiMo clips carry a quiet ~100ms lead-in (a soft breath/onset) before speech — heard as "starts quiet,
// then louder". When the caller hasn't asked for a specific start, begin at the first word's timestamp
// (less a small preroll so a soft onset isn't clipped) to drop that lead-in. Falls back to 0 when
// timings aren't warm yet, so it degrades to the old behaviour rather than guessing a fixed offset.
const LEAD_IN_PREROLL = 0.03; // seconds kept before the first word, as a safety margin vs clipping the onset
export const leadInSkip = (timings: WordTiming[] | null): number => {
  const first = timings?.[0]?.start;
  return first && isFinite(first) ? Math.max(0, first - LEAD_IN_PREROLL) : 0;
};
