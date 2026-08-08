import { createHash } from 'node:crypto';

export const OFFLINE_TTS_VOICES = [
  'qwen3-aiden-clear-v1',
  'qwen3-aiden-casual-v1',
] as const;

export interface OfflineTtsEntry {
  key: string;
  voice: typeof OFFLINE_TTS_VOICES[number];
  text: string;
  audioFile: string;
  timingsFile: string;
  audioSha256: string;
  timingsSha256: string;
  durationSeconds: number;
}

export interface OfflineTtsBundle {
  version: 1;
  generatedAt: number;
  model: string;
  aligner: string;
  entries: OfflineTtsEntry[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const VOICES = new Set<string>(OFFLINE_TTS_VOICES);

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function offlineTtsKey(text: string, voice: string): string {
  return createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
}

export function validateOfflineTtsBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  if (value.version !== 1) return 'unsupported bundle version';
  if (!Number.isFinite(value.generatedAt) || value.generatedAt <= 0) return 'bundle generatedAt is invalid';
  for (const field of ['model', 'aligner'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0 || value[field].length > 300) {
      return `bundle ${field} is invalid`;
    }
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 2_000) {
    return 'bundle entries must contain 1 to 2000 records';
  }

  const keys = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.key !== 'string' || !SHA256.test(entry.key)) return `entry ${index} key is invalid`;
    if (keys.has(entry.key)) return `entry ${index} duplicates key ${entry.key}`;
    keys.add(entry.key);
    if (typeof entry.voice !== 'string' || !VOICES.has(entry.voice)) return `entry ${index} voice is invalid`;
    if (typeof entry.text !== 'string' || entry.text.length === 0 || entry.text.length > 20_000 || entry.text !== entry.text.trim()) {
      return `entry ${index} text is invalid`;
    }
    if (offlineTtsKey(entry.text, entry.voice) !== entry.key) return `entry ${index} key does not match voice and text`;
    const prefix = entry.key.slice(0, 2);
    if (entry.audioFile !== `audio/${prefix}/${entry.key}.mp3`) return `entry ${index} audioFile is invalid`;
    if (entry.timingsFile !== `audio/${prefix}/${entry.key}.json`) return `entry ${index} timingsFile is invalid`;
    if (typeof entry.audioSha256 !== 'string' || !SHA256.test(entry.audioSha256)) return `entry ${index} audioSha256 is invalid`;
    if (typeof entry.timingsSha256 !== 'string' || !SHA256.test(entry.timingsSha256)) return `entry ${index} timingsSha256 is invalid`;
    if (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 0.2 || entry.durationSeconds > 180) {
      return `entry ${index} durationSeconds is invalid`;
    }
  }
  return null;
}
