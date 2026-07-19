import type { GeneratedImage, ImageGenerationErrorCode } from './image-generation.js';

export interface ImageBackfillScope {
  itemIds?: string[];
}

export interface ImageBackfillTarget {
  imageId: string;
  prompt: string;
}

export type ImageBackfillStopReason = 'cancelled' | 'quota_exceeded' | 'not_configured' | 'provider_error';

export interface ImageBackfillStatus {
  running: boolean;
  total: number;
  done: number;
  generated: number;
  failed: number;
  startedAt: number;
  finishedAt: number;
  stoppedReason?: ImageBackfillStopReason;
  lastError?: string;
}

interface JobRecord {
  status: ImageBackfillStatus;
  cancelRequested: boolean;
}

export interface ImageBackfillDependencies {
  loadItems: (userId: string) => any[];
  generateImage: (prompt: string, aspectRatio: '16:9') => Promise<GeneratedImage>;
  saveImage: (userId: string, imageId: string, image: GeneratedImage) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: number[];
  interItemDelayMs?: number;
}

function errorCode(error: unknown): ImageGenerationErrorCode | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return code === 'NO_API_KEY' || code === 'QUOTA_EXCEEDED' || code === 'UPSTREAM_ERROR' ? code : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Image generation failed');
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

export function collectImageBackfillTargets(items: any[], scope: ImageBackfillScope = {}): ImageBackfillTarget[] {
  const allowedIds = scope.itemIds ? new Set(scope.itemIds) : null;
  const targets = new Map<string, ImageBackfillTarget>();

  for (const item of items) {
    if (!item?.data || item.isDeleted || item.isArchived) continue;
    if (allowedIds && !allowedIds.has(item.data.id)) continue;

    if (item.type === 'vocab') {
      const prompt = typeof item.data.imagePrompt === 'string' ? item.data.imagePrompt.trim() : '';
      if (prompt && !item.data.imageUrl && !targets.has(item.data.id)) {
        targets.set(item.data.id, { imageId: item.data.id, prompt });
      }
      continue;
    }

    if (item.type === 'phrase' && Array.isArray(item.data.vocabs)) {
      const phrasePrompt = typeof item.data.imagePrompt === 'string' ? item.data.imagePrompt.trim() : '';
      if (item.data.id && phrasePrompt && !item.data.imageUrl && !targets.has(item.data.id)) {
        targets.set(item.data.id, { imageId: item.data.id, prompt: phrasePrompt });
      }
      for (const vocab of item.data.vocabs) {
        const prompt = typeof vocab?.imagePrompt === 'string' ? vocab.imagePrompt.trim() : '';
        if (vocab?.id && prompt && !vocab.imageUrl && !targets.has(vocab.id)) {
          targets.set(vocab.id, { imageId: vocab.id, prompt });
        }
      }
    }
  }

  return [...targets.values()];
}

export function createImageBackfillManager(dependencies: ImageBackfillDependencies) {
  const jobs = new Map<string, JobRecord>();
  const delay = dependencies.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const retryDelays = dependencies.retryDelaysMs ?? [2_000, 5_000];
  const interItemDelay = dependencies.interItemDelayMs ?? 500;

  const snapshot = (record: JobRecord | undefined): ImageBackfillStatus => record
    ? { ...record.status }
    : { running: false, total: 0, done: 0, generated: 0, failed: 0, startedAt: 0, finishedAt: 0 };

  const run = async (userId: string, record: JobRecord, targets: ImageBackfillTarget[]) => {
    let consecutiveFailures = 0;
    try {
      for (const target of targets) {
        if (record.cancelRequested) {
          record.status.stoppedReason = 'cancelled';
          break;
        }

        let generated: GeneratedImage | null = null;
        let terminalReason: ImageBackfillStopReason | undefined;
        let lastError = '';

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          try {
            generated = await dependencies.generateImage(target.prompt, '16:9');
            break;
          } catch (error) {
            const code = errorCode(error);
            lastError = errorMessage(error);
            if (record.cancelRequested) terminalReason = 'cancelled';
            if (code === 'QUOTA_EXCEEDED') terminalReason = 'quota_exceeded';
            if (code === 'NO_API_KEY') terminalReason = 'not_configured';
            if (terminalReason || attempt === retryDelays.length) break;
            await delay(retryDelays[attempt]);
          }
        }

        if (generated && dependencies.saveImage(userId, target.imageId, generated)) {
          record.status.generated++;
          consecutiveFailures = 0;
        } else {
          record.status.failed++;
          consecutiveFailures++;
          record.status.lastError = lastError || 'Generated image could not be stored';
        }
        record.status.done++;

        if (!terminalReason && consecutiveFailures >= 3) terminalReason = 'provider_error';
        if (terminalReason) {
          record.status.stoppedReason = terminalReason;
          break;
        }
        if (interItemDelay > 0) await delay(interItemDelay);
      }
    } catch (error) {
      record.status.stoppedReason = 'provider_error';
      record.status.lastError = errorMessage(error);
    } finally {
      record.status.running = false;
      record.status.finishedAt = Date.now();
    }
  };

  return {
    start(userId: string, scope: ImageBackfillScope = {}): ImageBackfillStatus {
      const existing = jobs.get(userId);
      if (existing?.status.running) return snapshot(existing);

      const targets = collectImageBackfillTargets(dependencies.loadItems(userId), scope);
      const now = Date.now();
      const record: JobRecord = {
        cancelRequested: false,
        status: {
          running: targets.length > 0,
          total: targets.length,
          done: 0,
          generated: 0,
          failed: 0,
          startedAt: now,
          finishedAt: targets.length > 0 ? 0 : now,
        },
      };
      jobs.set(userId, record);
      if (targets.length > 0) void run(userId, record, targets);
      return snapshot(record);
    },

    getStatus(userId: string): ImageBackfillStatus {
      return snapshot(jobs.get(userId));
    },

    cancel(userId: string): ImageBackfillStatus {
      const record = jobs.get(userId);
      if (record?.status.running) record.cancelRequested = true;
      return snapshot(record);
    },
  };
}
