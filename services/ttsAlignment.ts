/**
 * Maps a clicked word's character offset (within the STRIPPED sentence) to a playback time,
 * using the per-word timings the server produced (whisper word-alignment of the cached clip).
 *
 * The timings come from transcribing the synthesized audio, so a word's TEXT may occasionally be
 * mis-heard — but its START time is still correct. We anchor by sequentially locating each timing
 * word's text as a whole word in the stripped sentence (so a misheard "a" can't anchor inside "hat");
 * words we can't locate (mis-transcription, expanded numbers, pure punctuation) are simply skipped, and
 * a click on such a word resolves to the nearest earlier anchor. This degrades gracefully and never throws.
 */
import type { WordTiming } from './api';

export interface AlignedWord { charOffset: number; startTime: number }

const isPunctOnly = (s: string): boolean => /^[^\p{L}\p{N}]+$/u.test(s);
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** The first occurrence of `token` in `text` from `from` on that isn't part of a longer word, or -1. A token's
 *  edge that is punctuation (the apostrophe of "'t", say) needs no boundary next to it. */
const findWholeWord = (text: string, token: string, from: number): number => {
  const needsStart = isWordChar(token[0]);
  const needsEnd = isWordChar(token[token.length - 1]);
  for (let idx = text.indexOf(token, from); idx !== -1; idx = text.indexOf(token, idx + 1)) {
    if (needsStart && isWordChar(text[idx - 1])) continue;
    if (needsEnd && isWordChar(text[idx + token.length])) continue;
    return idx;
  }
  return -1;
};

/** Build [{charOffset, startTime}] anchors by walking a cursor through the stripped sentence. */
export const alignWordsToStripped = (stripped: string, words: WordTiming[] | null | undefined): AlignedWord[] => {
  if (!stripped || !words || !words.length) return [];
  const lower = stripped.toLowerCase();
  const out: AlignedWord[] = [];
  let cursor = 0;
  for (const w of words) {
    const t = (w?.text || '').trim().toLowerCase();
    if (!t || isPunctOnly(t)) continue;
    const idx = findWholeWord(lower, t, cursor);
    if (idx === -1) continue; // mis-heard / expanded token → no anchor, keep cursor
    out.push({ charOffset: idx, startTime: w.start });
    cursor = idx + t.length;
  }
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

// MiMo clips carry a quiet ~100ms lead-in (a soft breath/onset) before speech — heard as "starts quiet,
// then louder". When the caller hasn't asked for a specific start, begin at the first word's timestamp
// (less a small preroll so a soft onset isn't clipped) to drop that lead-in. Falls back to 0 when
// timings aren't warm yet, so it degrades to the old behaviour rather than guessing a fixed offset.
const LEAD_IN_PREROLL = 0.03; // seconds kept before the first word, as a safety margin vs clipping the onset
export const leadInSkip = (timings: WordTiming[] | null): number => {
  const first = timings?.[0]?.start;
  return first && isFinite(first) ? Math.max(0, first - LEAD_IN_PREROLL) : 0;
};
