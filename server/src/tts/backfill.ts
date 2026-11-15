// The background backfill: audio and word timings for every saved sentence and both catalogs, generated on the
// server so no client has to stay open.
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { env } from '../env.js';
import { getAllSentenceTexts } from '../db.js';
import { getAllRealLifeCatalogSentenceTexts } from '../real-life-catalog.js';
import { getAllEssayCatalogSentenceTexts } from '../essay-catalog.js';
import { CASUAL_STYLE, fileExists, isComplete, MIMO_VOICE, pathForKey, ttsKey } from './cache.js';
import { reduceCasualBatch } from './casual.js';
import { generateAndVerify } from './clips.js';

const BACKFILL_STATUS_PATH = resolve(env.DATA_DIR, 'tts-backfill-status.json');

// Generates audio + word timings for EVERY saved sentence, server-side, detached from any request —
// so the client never has to stay open. Idempotent (generateAndVerify skips clips that already have
// both files) and resumable (a restart just re-scans and skips what's done). Low concurrency since the
// work is I/O-bound (DeepInfra + tiny file writes), so it doesn't starve normal request serving.
const stripMarkers = (t: string): string =>
  (t || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1').trim();

type BackfillStatus = { running: boolean; total: number; done: number; generated: number; failed: number; startedAt: number; finishedAt: number };
let backfill: BackfillStatus = { running: false, total: 0, done: 0, generated: 0, failed: 0, startedAt: 0, finishedAt: 0 };
export function getBackfillStatus(): BackfillStatus { return { ...backfill }; }

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
  const catalog = Array.from(new Set(catalogInput.map(stripMarkers).filter(Boolean)));
  const catalogSet = new Set(catalog);
  const library = Array.from(new Set(libraryInput.map(stripMarkers).filter(Boolean)))
    .filter(text => !catalogSet.has(text));
  return { catalog, library };
}

async function runBackfillGroup(texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  // ── Clear pass: per-item parallel (each item also runs a whisper alignment). ──
  let idx = 0;
  const clearWorker = async () => {
    while (idx < texts.length) {
      const text = texts[idx++];
      const key = ttsKey(text, MIMO_VOICE);
      if (!(await isComplete(key))) {
        const result = await retryBackfillOperation(() => generateAndVerify(text, MIMO_VOICE));
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill clear item failed after ${result.attempts} attempts:`, e?.message);
        }
      }
      backfill.done++;
    }
  };
  await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => clearWorker()));

  // ── Casual pass ──
  // Split work: clips MISSING audio need a (batched) reduce + voice-design synth; clips that already
  // have audio but lack timings (legacy casual clips) just need a whisper alignment — no reduce/synth.
  const needAudio: string[] = [];
  const needTimingsOnly: string[] = [];
  for (const text of texts) {
    const k = ttsKey(text, CASUAL_STYLE);
    if (await isComplete(k)) continue;
    if (await fileExists(pathForKey(k))) needTimingsOnly.push(text);
    else needAudio.push(text);
  }
  backfill.done += texts.length - needAudio.length - needTimingsOnly.length; // already-complete casual

  // Timings-only: cheap, parallel (generateAndVerify skips synth, just aligns + writes timings).
  {
    let t = 0;
    const timingsWorker = async () => {
      while (t < needTimingsOnly.length) {
        const text = needTimingsOnly[t++];
        const result = await retryBackfillOperation(() => generateAndVerify(text, CASUAL_STYLE));
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill casual timings failed after ${result.attempts} attempts:`, e?.message);
        }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => timingsWorker()));
  }

  // Missing-audio: batch-reduce the spoken text (cheap throughput), then synth + align each clip.
  const CHUNK = 20;
  for (let i = 0; i < needAudio.length; i += CHUNK) {
    const chunk = needAudio.slice(i, i + CHUNK);
    let reduced: Array<string | null>;
    try {
      reduced = await reduceCasualBatch(chunk);
    } catch (e: any) {
      console.warn('[tts] backfill reduce batch failed, respelling each clip separately:', e?.message);
      reduced = chunk.map(() => null); // a missing respelling is retried per clip, never voiced as-is
    }
    let j = 0;
    const casualWorker = async () => {
      while (j < chunk.length) {
        const k = j++;
        const result = await retryBackfillOperation(
          () => generateAndVerify(chunk[k], CASUAL_STYLE, reduced[k] ?? undefined),
        );
        if (result.succeeded) backfill.generated++;
        else {
          const e = result.error as any;
          backfill.failed++;
          console.warn(`[tts] backfill casual item failed after ${result.attempts} attempts:`, e?.message);
        }
        backfill.done++;
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => casualWorker()));
  }
}

export async function runBackfill(): Promise<void> {
  if (backfill.running) return;
  // Synchronous setup (runs before the first await, so a non-awaiting caller still sees `total`).
  let catalogTexts: string[];
  let libraryTexts: string[];
  try {
    ({ catalog: catalogTexts, library: libraryTexts } = partitionBackfillTexts(
      [...getAllRealLifeCatalogSentenceTexts(), ...getAllEssayCatalogSentenceTexts()],
      getAllSentenceTexts(),
    ));
  } catch (e: any) {
    console.warn('[tts] backfill: failed to read items:', e?.message);
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
