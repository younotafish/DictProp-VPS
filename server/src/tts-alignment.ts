export interface WordTiming {
  start: number;
  end: number;
  text: string;
}

function finiteOffset(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanWord(value: string): string {
  return value.trim()
    .replace(/^[^\p{L}\p{N}']+/u, '')
    .replace(/[^\p{L}\p{N}']+$/u, '');
}

function tokenTimings(transcription: any[]): WordTiming[] {
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
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      const raw = typeof token?.text === 'string' ? token.text : '';
      const startMs = finiteOffset(token?.offsets?.from);
      const endMs = finiteOffset(token?.offsets?.to);
      if (!raw || startMs === null || endMs === null || endMs <= startMs || /^<\|.*\|>$/.test(raw.trim())) continue;
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

function segmentTimings(transcription: any[]): WordTiming[] {
  const output: WordTiming[] = [];
  for (const segment of transcription) {
    const startMs = finiteOffset(segment?.offsets?.from);
    const endMs = finiteOffset(segment?.offsets?.to);
    const words: string[] = typeof segment?.text === 'string'
      ? segment.text.split(/\s+/).map(cleanWord).filter(Boolean)
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
  const transcription = value && typeof value === 'object' && Array.isArray((value as any).transcription)
    ? (value as any).transcription
    : [];
  const tokens = tokenTimings(transcription);
  return tokens.length > 0 ? tokens : segmentTimings(transcription);
}
