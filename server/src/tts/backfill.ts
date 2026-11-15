// The background backfill: audio and word timings for every saved sentence and both catalogs, generated on the
// server so no client has to stay open.
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { env } from '../env.js';
import { getAllSentenceTexts } from '../db.js';
import { getAllRealLifeCatalogSentenceTexts } from '../real-life-catalog.js';
import { getAllEssayCatalogSentenceTexts } from '../essay-catalog.js';
import { stripSentenceMarkers } from '../shared/sentence-markers.js';
import { audioPath, CASUAL_STYLE, fileExists, isComplete, MIMO_VOICE, ttsKey } from './cache.js';
import { reduceCasualBatch, RESPELLING_BATCH_SIZE, respellingUnavailable } from './casual.js';
import type { ClipStore } from './clips.js';
import { runPool } from './pool.js';

const BACKFILL_STATUS_PATH = resolve(env.DATA_DIR, 'tts-backfill-status.json');

// Generates audio + word timings for EVERY saved sentence, server-side, detached from any request —
// so the client never has to stay open. Idempotent (generateAndVerify skips clips that already have
// both files) and resumable (a restart just re-scans and skips what's done). Low concurrency since the
// work is I/O-bound (DeepInfra + tiny file writes), so it doesn't starve normal request serving.
// A clip is keyed by a sentence's speakable text, exactly as the client derives it (stripSentenceMarkers, trimmed).
const speakableText = (text: string): string => stripSentenceMarkers(text).trim();

export type BackfillStatus = { running: boolean; total: number; done: number; generated: number; failed: number; startedAt: number; finishedAt: number };

export async function getDetachedBackfillStatus(): Promise<BackfillStatus | null> {
  try {
    const value = JSON.parse(await readFile(BACKFILL_STATUS_PATH, 'utf8'));
    const heartbeatAt = Number(value?.heartbeatAt);
    if (value?.running !== true || !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > 120_000) return null;
    return {
      running: true,
      total: Number(value.total) || 0,
      done: Number(value.done) || 0,
      generated: Number(value.generated) || 0,
      failed: Number(value.failed) || 0,
      startedAt: Number(value.startedAt) || 0,
      finishedAt: Number(value.finishedAt) || 0,
    };
  } catch {
    return null;
  }
}

const BACKFILL_CONCURRENCY = 2;
const BACKFILL_GENERATION_ATTEMPTS = 3;
const BACKFILL_RETRY_DELAY_MS = 1_000;

export async function retryBackfillOperation(
  operation: () => Promise<void>,
  attempts = BACKFILL_GENERATION_ATTEMPTS,
  delayMs = BACKFILL_RETRY_DELAY_MS,
): Promise<{ succeeded: boolean; attempts: number; error?: unknown }> {
  const boundedAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    try {
      await operation();
      return { succeeded: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts && delayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs * attempt));
      }
    }
  }
  return { succeeded: false, attempts: boundedAttempts, error: lastError };
}

export function partitionBackfillTexts(catalogInput: string[], libraryInput: string[]): {
  catalog: string[];
  library: string[];
} {
  const catalog = Array.from(new Set(catalogInput.map(speakableText).filter(Boolean)));
  const catalogSet = new Set(catalog);
  const library = Array.from(new Set(libraryInput.map(speakableText).filter(Boolean)))
    .filter(text => !catalogSet.has(text));
  return { catalog, library };
}

/** The texts a backfill covers, markers and all: both catalogs, then the saved library. */
export interface BackfillTexts {
  catalog: string[];
  library: string[];
}

export function defaultBackfillTexts(): BackfillTexts {
  return {
    catalog: [...getAllRealLifeCatalogSentenceTexts(), ...getAllEssayCatalogSentenceTexts()],
    library: getAllSentenceTexts(),
  };
}

export interface BackfillOptions {
  clips: ClipStore;
  /** Respells many sentences in one call; a null entry is respelled on its own when its clip is made. */
  reduceBatch?: (sentences: string[]) => Promise<Array<string | null>>;
  sentenceTexts?: () => BackfillTexts;
  retryDelayMs?: number;
}

export interface Backfill {
  /** This process's run: running, or the last one's counts. */
  status(): BackfillStatus;
  /** Starts a run unless one is going in this process; resolves when it ends. */
  run(): Promise<void>;
}

export function createBackfill({
  clips,
  reduceBatch = reduceCasualBatch,
  sentenceTexts = defaultBackfillTexts,
  retryDelayMs = BACKFILL_RETRY_DELAY_MS,
}: BackfillOptions): Backfill {
  let backfill: BackfillStatus = { running: false, total: 0, done: 0, generated: 0, failed: 0, startedAt: 0, finishedAt: 0 };
  const retry = (operation: () => Promise<void>) =>
    retryBackfillOperation(operation, BACKFILL_GENERATION_ATTEMPTS, retryDelayMs);

  // Set when a respelling batch fails for a reason that lasts the whole run (a spent balance, a missing or refused
  // key). The run's remaining casual clips that need audio then count as failed without each paying for calls that
  // cannot succeed; the next run tries again.
  let respellingHalted = false;

  const record = (result: Awaited<ReturnType<typeof retry>>, label: string) => {
    if (result.succeeded) backfill.generated++;
    else {
      backfill.failed++;
      console.warn(`[tts] backfill ${label} failed after ${result.attempts} attempts:`, (result.error as Error | undefined)?.message);
    }
  };

  async function runBackfillGroup(texts: string[]): Promise<void> {
    if (texts.length === 0) return;
    // ── Clear pass: per-item parallel (each item also runs a whisper alignment). ──
    await runPool(texts, BACKFILL_CONCURRENCY, async (text) => {
      if (!(await isComplete(ttsKey(text, MIMO_VOICE)))) {
        record(await retry(() => clips.generateAndVerify(text, MIMO_VOICE)), 'clear item');
      }
      backfill.done++;
    });

    // ── Casual pass ──
    // Split work: clips MISSING audio need a (batched) reduce + voice-design synth; clips that already
    // have audio but lack timings (legacy casual clips) just need a whisper alignment — no reduce/synth.
    const needAudio: string[] = [];
    const needTimingsOnly: string[] = [];
    for (const text of texts) {
      const k = ttsKey(text, CASUAL_STYLE);
      if (await isComplete(k)) continue;
      if (await fileExists(audioPath(k))) needTimingsOnly.push(text);
      else needAudio.push(text);
    }
    backfill.done += texts.length - needAudio.length - needTimingsOnly.length; // already-complete casual

    // Timings-only: cheap, parallel (generateAndVerify skips synth, just aligns + writes timings).
    await runPool(needTimingsOnly, BACKFILL_CONCURRENCY, async (text) => {
      record(await retry(() => clips.generateAndVerify(text, CASUAL_STYLE)), 'casual timings');
      backfill.done++;
    });

    // Missing-audio: batch-reduce the spoken text (cheap throughput), then synth + align each clip.
    for (let i = 0; i < needAudio.length; i += RESPELLING_BATCH_SIZE) {
      const chunk = needAudio.slice(i, i + RESPELLING_BATCH_SIZE);
      let reduced: Array<string | null> = [];
      if (!respellingHalted) {
        try {
          reduced = await reduceBatch(chunk);
        } catch (e) {
          if (respellingUnavailable(e)) {
            respellingHalted = true;
            console.warn(`[tts] backfill: casual respelling unavailable (${e.kind}: ${e.message}); this run skips the casual clips that still need audio`);
          } else {
            console.warn('[tts] backfill reduce batch failed, respelling each clip separately:', (e as Error)?.message);
            reduced = chunk.map(() => null); // a missing respelling is retried per clip, never voiced as-is
          }
        }
      }
      if (respellingHalted) {
        backfill.failed += chunk.length;
        backfill.done += chunk.length;
        continue;
      }
      await runPool(chunk, BACKFILL_CONCURRENCY, async (text, k) => {
        record(await retry(() => clips.generateAndVerify(text, CASUAL_STYLE, reduced[k] ?? undefined)), 'casual item');
        backfill.done++;
      });
    }
  }

  async function runBackfill(): Promise<void> {
    if (backfill.running) return;
    respellingHalted = false;
    // Synchronous setup (runs before the first await, so a non-awaiting caller still sees `total`).
    let catalogTexts: string[];
    let libraryTexts: string[];
    try {
      const { catalog, library } = sentenceTexts();
      ({ catalog: catalogTexts, library: libraryTexts } = partitionBackfillTexts(catalog, library));
    } catch (e) {
      console.warn('[tts] backfill: failed to read items:', (e as Error | undefined)?.message);
      return;
    }
    const sentenceCount = catalogTexts.length + libraryTexts.length;
    // Two styles per sentence, each with audio and word timings.
    backfill = { running: true, total: sentenceCount * 2, done: 0, generated: 0, failed: 0, startedAt: Date.now(), finishedAt: 0 };
    console.log(`[tts] backfill: starting for ${sentenceCount} sentences × 2 styles`);

    // The catalog is finite and product-critical. Finish both styles there before scanning the much
    // larger saved-item library, otherwise a new collection's casual track can wait for days.
    await runBackfillGroup(catalogTexts);
    await runBackfillGroup(libraryTexts);

    backfill.running = false;
    backfill.finishedAt = Date.now();
    console.log(`[tts] backfill done: generated=${backfill.generated} skipped=${backfill.total - backfill.generated - backfill.failed} failed=${backfill.failed}`);
  }

  return { status: () => ({ ...backfill }), run: runBackfill };
}
