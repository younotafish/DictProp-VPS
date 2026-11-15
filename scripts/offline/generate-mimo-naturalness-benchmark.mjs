#!/usr/bin/env node

// Render the current MiMo baseline with curl (the only outbound client permitted on this host).
// These clips are paired with generate-qwen-naturalness-benchmark.py for blinded human listening.

import { createHash } from 'node:crypto';
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writePrivateJson } from './offline-io.mjs';

const TEST_SENTENCES = [
  "I'd have brought it up earlier, but I didn't want to put you on the spot.",
  "If we'd known the kitchen was closing, we would've placed the order a little sooner.",
  "Could you walk me through what we're supposed to do if the connection gets canceled?",
  "We're going to have to take the next train unless they hold this one for us.",
  "Do you want to grab a quick bite after we check into the hotel?",
];
const MIMO_URL = 'https://api.deepinfra.com/v1/inference/XiaomiMiMo/MiMo-V2.5-tts';

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = resolve('.env');
  if (!existsSync(envPath)) return '';
  const line = readFileSync(envPath, 'utf8').split(/\r?\n/).find(value => value.startsWith(`${name}=`));
  if (!line) return '';
  return line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

// The ffmpeg on PATH, else the one this study first ran with.
function defaultFfmpeg() {
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'ffmpeg');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return '/Users/cjs/.local/bin/ffmpeg';
}

const outputRoot = resolve(option('--output', 'data/offline-backfill/tts-naturalness-benchmark/mimo'));
const sentenceLimit = Math.max(0, Number(option('--sentence-limit', '0')) || 0);
const ffmpeg = option('--ffmpeg', process.env.FFMPEG_BIN || defaultFfmpeg());
const apiKey = envValue('DEEPINFRA_API_KEY');
if (!apiKey) throw new Error('DEEPINFRA_API_KEY is required');
mkdirSync(outputRoot, { recursive: true });
// The key reaches curl through a private file, as in server/src/proxy-fetch.ts: any local process can read a command
// line.
const headerDir = mkdtempSync(join(tmpdir(), 'dictprop-mimo-'));
const authorizationHeader = join(headerDir, 'authorization');
writeFileSync(authorizationHeader, `Authorization: Bearer ${apiKey}\n`, { mode: 0o600 });

const entries = [];
try {
  for (const [sentenceIndex, text] of TEST_SENTENCES.slice(0, sentenceLimit || undefined).entries()) {
    const digest = createHash('sha256').update(`mimo-v2.5-mia\n${text}`).digest('hex');
    const audioPath = resolve(outputRoot, `${digest}.mp3`);
    if (!existsSync(audioPath)) {
      const response = spawnSync('curl', [
        '--fail', '--silent', '--show-error', '--max-time', '120', MIMO_URL,
        '-H', `@${authorizationHeader}`,
        '-H', 'Content-Type: application/json',
        '--data-binary', JSON.stringify({ text, voice: 'Mia', output_format: 'wav' }),
      ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      if (response.status !== 0) throw new Error(`MiMo request failed: ${response.stderr.slice(-1_000)}`);
      const payload = JSON.parse(response.stdout);
      const encoded = String(payload.audio || '').replace(/^data:[^,]*,/, '');
      if (!encoded) throw new Error('MiMo returned no audio');
      const wavPath = resolve(outputRoot, `${digest}.wav`);
      writeFileSync(wavPath, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      // A clip appears under its final name only once ffmpeg has finished it, so a timeout or Ctrl-C never leaves a
      // cut-off clip that the next run would take as done.
      const temporaryAudioPath = `${audioPath}.tmp`;
      const transcode = spawnSync(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath,
        '-af', 'loudnorm=I=-18:TP=-2:LRA=7', '-ar', '24000', '-ac', '1', '-b:a', '96k', '-f', 'mp3', temporaryAudioPath,
      ], { encoding: 'utf8', timeout: 90_000 });
      unlinkSync(wavPath);
      if (transcode.status !== 0) {
        rmSync(temporaryAudioPath, { force: true });
        throw new Error(`ffmpeg failed: ${transcode.error?.message ?? transcode.stderr.slice(-1_000)}`);
      }
      renameSync(temporaryAudioPath, audioPath);
    }
    entries.push({ sentenceIndex, text, recipe: 'mimo-v2.5-mia', file: audioPath.split('/').at(-1) });
    process.stderr.write(`[${sentenceIndex + 1}/${sentenceLimit || TEST_SENTENCES.length}] MiMo Mia\n`);
  }
} finally {
  rmSync(headerDir, { recursive: true, force: true });
}

writePrivateJson(resolve(outputRoot, 'manifest.json'), {
  version: 1,
  generatedAt: Date.now(),
  model: 'XiaomiMiMo/MiMo-V2.5-tts',
  entries,
});
