/**
 * Maps a clicked word's character offset (within the STRIPPED sentence) to a playback time,
 * using the per-word timings the server produced (whisper word-alignment of the cached clip).
 *
 * The timings come from transcribing the synthesized audio, so a word's TEXT may occasionally be
 * mis-heard — but its START time is still correct. We anchor by sequentially locating each timing
 * word's text in the stripped sentence; words we can't locate (mis-transcription, expanded numbers,
 * pure punctuation) are simply skipped, and a click on such a word resolves to the nearest earlier
 * anchor. This degrades gracefully and never throws.
 */
import type { WordTiming } from './api';

export interface AlignedWord { charOffset: number; startTime: number }

const isPunctOnly = (s: string): boolean => /^[^\p{L}\p{N}]+$/u.test(s);

/** Build [{charOffset, startTime}] anchors by walking a cursor through the stripped sentence. */
export const alignWordsToStripped = (stripped: string, words: WordTiming[] | null | undefined): AlignedWord[] => {
  if (!stripped || !words || !words.length) return [];
  const lower = stripped.toLowerCase();
  const out: AlignedWord[] = [];
  let cursor = 0;
  for (const w of words) {
    const t = (w?.text || '').trim().toLowerCase();
    if (!t || isPunctOnly(t)) continue;
    const idx = lower.indexOf(t, cursor);
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
