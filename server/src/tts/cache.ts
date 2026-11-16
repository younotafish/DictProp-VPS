// The server's speech cache on disk, shared by the routes, the backfill and the offline importer. A clip lives at
// DATA_DIR/tts/<key[:2]>/<key> (extension-less; the content type is sniffed when served), its word timings in
// <key>.json beside it, and a casual clip's respelling in <key>.txt. Clips are immutable: served for a year and
// never rewritten. The cache is GLOBAL, keyed by voice and text and shared across users, since pronunciation
// isn't user-private; requireAuth (mounted on /api/*) still gates the routes that serve it.
import { createHash, randomUUID } from 'crypto';
import { access, link, open, rename, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { env } from '../env.js';
import { isSha256 } from '../validation-helpers.js';

// Default English voice. Options: Mia, Chloe (female), Milo, Dean (male), mimo_default.
export const MIMO_VOICE = 'Mia';
// The casual track's style token (see casual.ts): the cache's "voice" field doubles as the track.
export const CASUAL_STYLE = 'casual';
// Versioned voices that are generated, aligned and verified on the Mac and imported through the offline bridge;
// the server never synthesizes them.
export const OFFLINE_TTS_VOICES = [
  'qwen3-aiden-clear-v1',
  'qwen3-aiden-casual-v1',
] as const;
const OFFLINE_VOICES = new Set<string>(OFFLINE_TTS_VOICES);
export const isOfflineVoice = (voice: string): boolean => OFFLINE_VOICES.has(voice);
export const TTS_DIR = resolve(env.DATA_DIR, 'tts');

// key = sha256(voice + "\n" + text.trim()) hex — MUST match the client (services/api/tts.ts ttsKey).
export function ttsKey(text: string, voice: string): string {
  return createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
}

export const isCacheKey = (value: string): boolean => isSha256(value);

export function audioPath(key: string): string {
  return join(TTS_DIR, key.slice(0, 2), key);
}

// Per-word timings live in a sibling JSON next to the (extension-less) audio file — no collision.
export function timingsPath(key: string): string {
  return audioPath(key) + '.json';
}

export function respellingPath(key: string): string {
  return audioPath(key) + '.txt';
}

export async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Replace a file whole: written under a temp name beside it, then renamed over it, so a reader never sees half of
// it. For files that may change (a casual clip's respelling, the backfill's status); clips use publishOnce.
export async function writeFileAtomic(path: string, data: Buffer | string, options: { mode?: number } = {}): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, options);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// What link() answers on a filesystem without hard links; publishOnce then renames instead.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

/**
 * Store a file under its final name unless one is already there; resolves whether this call stored it. Several
 * writers can make the same clip at once (this process's routes and backfill, a detached backfill worker): the first
 * to finish wins and the others' bytes are dropped, so a clip that may already have been served never changes and its
 * timings describe the audio on disk. The bytes are written and synced under a unique temp name beside the target,
 * then hard-linked into place, since link() refuses a taken name where rename() would replace it. Without hard links
 * it renames instead, after checking that the name is free.
 */
export async function publishOnce(path: string, data: Buffer | string): Promise<boolean> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data);
      // Synced before the name appears, so a crash can't leave an empty clip under it for good.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return false;
      if (!NO_HARD_LINKS.has(code)) throw error;
    }
    if (await fileExists(path)) return false;
    await rename(temp, path);
    return true;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

// Sniff audio content-type from the leading bytes (we store mp3 normally, wav as the no-ffmpeg fallback).
export function sniffContentType(buf: Buffer): string {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'audio/mpeg';
}

// A clip is "complete" when it has both audio and word timings (both styles now). Used by /generate
// and the backfill to skip finished clips (and to backfill timings onto legacy audio-only clips).
export async function isComplete(key: string): Promise<boolean> {
  return (await fileExists(audioPath(key))) && (await fileExists(timingsPath(key)));
}
