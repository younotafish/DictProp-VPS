// The server's speech cache on disk. Files live under DATA_DIR/tts/<key[:2]>/<key> (extension-less; the
// content type is sniffed when served), with the clip's word timings in <key>.json beside it. The cache is
// GLOBAL, keyed by voice and text and shared across users, since pronunciation isn't user-private;
// requireAuth (mounted on /api/*) still gates the routes that serve it.
import { createHash, randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { access, rename, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { env } from '../env.js';

// Default English voice. Options: Mia, Chloe (female), Milo, Dean (male), mimo_default.
export const MIMO_VOICE = 'Mia';
// The casual track's style token (see casual.ts): the cache's "voice" field doubles as the track.
export const CASUAL_STYLE = 'casual';
export const OFFLINE_CACHE_VOICES = new Set([
  'qwen3-aiden-clear-v1',
  'qwen3-aiden-casual-v1',
]);
export const TTS_DIR = resolve(env.DATA_DIR, 'tts');

mkdirSync(TTS_DIR, { recursive: true });

// key = sha256(voice + "\n" + text.trim()) hex — MUST match the client (services/api.ts ttsKey).
export function ttsKey(text: string, voice: string): string {
  return createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
}

export function pathForKey(key: string): string {
  return join(TTS_DIR, key.slice(0, 2), key);
}

// Per-word timings live in a sibling JSON next to the (extension-less) audio file — no collision.
export function timingsPathForKey(key: string): string {
  return pathForKey(key) + '.json';
}

export async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Write through a temp file + rename: clips are served as immutable for a year, so a crash mid-write
// must never leave a truncated file under the final name.
export async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
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
  return (await fileExists(pathForKey(key))) && (await fileExists(timingsPathForKey(key)));
}
