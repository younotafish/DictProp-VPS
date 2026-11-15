// Word timings from whisper.cpp's full JSON output (whisper-cli -ojf): words built from the token timestamps, or,
// when the output has none, each segment's span shared among its words by length.
export interface WordTiming {
  start: number;
  end: number;
  text: string;
}

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

function finiteOffset(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanWord(value: string): string {
  return value.trim()
    .replace(/^[^\p{L}\p{N}']+/u, '')
    .replace(/[^\p{L}\p{N}']+$/u, '');
}

// whisper.cpp's special tokens ([_BEG_], [_TT_<n>] timestamps, [_SOT_], [_EOT_]) and OpenAI's spelling of them
// (<|startoftranscript|>). The pinned whisper.cpp gives them zero-length spans, which are skipped anyway; one with a
// span must still never join a word.
const SPECIAL_TOKEN = /^(?:<\|.*\|>|\[_[A-Za-z_]+\d*\])$/;

function tokenTimings(transcription: unknown[]): WordTiming[] {
  const output: WordTiming[] = [];
  let current: { text: string; startMs: number; endMs: number } | null = null;
  const flush = () => {
    if (!current) return;
    const text = cleanWord(current.text);
    if (text && current.endMs > current.startMs) {
      output.push({ start: current.startMs / 1_000, end: current.endMs / 1_000, text });
    }
    current = null;
  };

  for (const segment of transcription) {
    const tokens = asRecord(segment)?.tokens;
    for (const token of Array.isArray(tokens) ? tokens : []) {
      const fields = asRecord(token);
      const raw = typeof fields?.text === 'string' ? fields.text : '';
      const offsets = asRecord(fields?.offsets);
      const startMs = finiteOffset(offsets?.from);
      const endMs = finiteOffset(offsets?.to);
      if (!raw || startMs === null || endMs === null || endMs <= startMs || SPECIAL_TOKEN.test(raw.trim())) continue;
      if (!current || /^\s/u.test(raw)) {
        flush();
        current = { text: raw, startMs, endMs };
      } else {
        current.text += raw;
        current.endMs = Math.max(current.endMs, endMs);
      }
    }
    flush();
  }
  return output;
}

function segmentTimings(transcription: unknown[]): WordTiming[] {
  const output: WordTiming[] = [];
  for (const segment of transcription) {
    const fields = asRecord(segment);
    const offsets = asRecord(fields?.offsets);
    const startMs = finiteOffset(offsets?.from);
    const endMs = finiteOffset(offsets?.to);
    const words: string[] = typeof fields?.text === 'string'
      ? fields.text.split(/\s+/).map(cleanWord).filter(Boolean)
      : [];
    if (startMs === null || endMs === null || endMs <= startMs || words.length === 0) continue;
    const weights = words.map(word => Math.max(1, [...word].length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = startMs;
    for (let index = 0; index < words.length; index++) {
      const next = index === words.length - 1
        ? endMs
        : cursor + (endMs - startMs) * (weights[index] / totalWeight);
      output.push({ start: cursor / 1_000, end: next / 1_000, text: words[index] });
      cursor = next;
    }
  }
  return output;
}

export function parseWhisperCppTimings(value: unknown): WordTiming[] {
  const output = asRecord(value)?.transcription;
  const transcription: unknown[] = Array.isArray(output) ? output : [];
  const tokens = tokenTimings(transcription);
  return tokens.length > 0 ? tokens : segmentTimings(transcription);
}
