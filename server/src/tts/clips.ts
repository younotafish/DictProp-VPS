// Making a clip: synthesize and store its audio, then align and store its word timings, each once even when several
// requests (or the backfill) ask for the same clip at the same time.
import { mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { alignAudioLocally, promoteAlignment, type AlignmentPriority } from '../local-whisper.js';
import type { WordTiming } from '../tts-alignment.js';
import {
  audioPath,
  CASUAL_STYLE,
  fileExists,
  isComplete,
  isOfflineVoice,
  respellingPath,
  timingsPath,
  publishOnce,
  TTS_DIR,
  ttsKey,
  writeFileAtomic,
} from './cache.js';
import { reduceToCasual } from './casual.js';
import { synthCasual, synthClear } from './synthesis.js';

function isCasual(voice: string): boolean {
  return voice === CASUAL_STYLE;
}

// The network and whisper steps, swappable so tests can drive the routes without DeepInfra or whisper.
export interface ClipDependencies {
  synthClear(text: string, voice: string): Promise<Buffer>;
  synthCasual(spoken: string): Promise<Buffer>;
  reduce(sentence: string): Promise<string | null>;
  /** Word timings for the clip `key`, queued at `priority`. */
  align(audio: Buffer, priority: AlignmentPriority, key: string): Promise<WordTiming[]>;
  /** Moves the clip's queued alignment ahead of background work. */
  promote(key: string): void;
}

export const defaultClipDependencies: ClipDependencies = {
  synthClear,
  synthCasual,
  reduce: reduceToCasual,
  align: (audio, priority, key) => alignAudioLocally(audio, { priority, key }),
  promote: promoteAlignment,
};

export interface ClipStore {
  ensureAudio(text: string, voice: string, reduced?: string): Promise<Buffer | null>;
  ensureTimings(key: string, priority: AlignmentPriority, fresh?: Buffer | null): Promise<void>;
  generateAndVerify(text: string, voice: string, reduced?: string): Promise<void>;
}

/** Clip generation on top of the cache. One store per process, so the routes and the backfill share its dedupe. */
export function createClipStore(deps: ClipDependencies): ClipStore {
  // In-flight dedupe so concurrent requests for the same key generate (or align) only once.
  const audioInFlight = new Map<string, Promise<Buffer | null>>();
  const timingsInFlight = new Map<string, { job: Promise<void>; priority: AlignmentPriority }>();

  // Synthesize + store a clip's audio unless it already exists. `voice` doubles as the style: the
  // CASUAL_STYLE sentinel runs the casual recipe (AI-reduce the text, then voice-design TTS); any other
  // value is a MiMo voice (clear track). `reduced` lets the backfill pass a pre-batched casual respelling.
  // Resolves the new bytes, or null when the clip was already on disk or another writer stored it first.
  function ensureAudio(text: string, voice: string, reduced?: string): Promise<Buffer | null> {
    const key = ttsKey(text, voice);
    const existing = audioInFlight.get(key);
    if (existing) return existing;
    const job = (async () => {
      if (isOfflineVoice(voice)) {
        throw new Error(`${voice} is populated only by the verified offline audio bridge`);
      }
      const p = audioPath(key);
      if (await fileExists(p)) return null;
      let audio: Buffer;
      let spoken: string | null = null;
      if (isCasual(voice)) {
        spoken = reduced ?? (await deps.reduce(text));
        // Nothing is stored, so a later request or backfill pass retries the respelling.
        if (!spoken) throw new Error('casual respelling failed');
        audio = await deps.synthCasual(spoken);
      } else {
        audio = await deps.synthClear(text, voice);
      }
      mkdirSync(join(TTS_DIR, key.slice(0, 2)), { recursive: true });
      // Another process may have stored this clip while it was synthesized here. Its copy stays, and the timings are
      // aligned on the bytes actually stored.
      if (!(await publishOnce(p, audio))) return null;
      // Keep the respelling beside the clip: the only record of what a casual clip actually says. Best-effort.
      if (spoken) await writeFileAtomic(respellingPath(key), spoken).catch(() => {});
      return audio;
    })().finally(() => audioInFlight.delete(key));
    audioInFlight.set(key, job);
    return job;
  }

  // Align + store a clip's word timings unless they already exist. A clip whisper hears no words in
  // stores [] so it counts as complete instead of being re-aligned by every sweep; a failed alignment
  // stores nothing, so a later request retries it. `fresh` saves re-reading audio just synthesized.
  function ensureTimings(key: string, priority: AlignmentPriority, fresh?: Buffer | null): Promise<void> {
    const existing = timingsInFlight.get(key);
    if (existing) {
      // Someone is waiting on this clip now: its alignment, queued or about to be, goes ahead of background work.
      if (priority === 'interactive' && existing.priority === 'background') {
        existing.priority = 'interactive';
        deps.promote(key);
      }
      return existing.job;
    }
    const entry = { job: Promise.resolve(), priority };
    entry.job = (async () => {
      const tp = timingsPath(key);
      if (await fileExists(tp)) return;
      const audio = fresh ?? (await readFile(audioPath(key)));
      let words: WordTiming[];
      try {
        words = await deps.align(audio, entry.priority, key);
      } catch (error) {
        console.warn('[tts] local whisper alignment failed:', (error as Error | undefined)?.message);
        return;
      }
      await publishOnce(tp, JSON.stringify(words));
    })().finally(() => timingsInFlight.delete(key));
    timingsInFlight.set(key, entry);
    return entry.job;
  }

  // Word timings for BOTH styles. The casual audio's reduced text keeps word order, so index-aligned
  // seek lands close (start times stay correct even if whisper mishears a mumbled word). Covers fresh
  // clips AND legacy audio-only clips (no audio regen).
  async function generateAndVerify(text: string, voice: string, reduced?: string): Promise<void> {
    const key = ttsKey(text, voice);
    const fresh = await ensureAudio(text, voice, reduced);
    await ensureTimings(key, 'background', fresh);
    if (!(await isComplete(key))) {
      throw new Error('audio or local word timings are still incomplete');
    }
  }

  return { ensureAudio, ensureTimings, generateAndVerify };
}
