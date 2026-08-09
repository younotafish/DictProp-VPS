#!/usr/bin/env node

// Render the current MiMo baseline with curl (the only outbound client permitted on this host).
// These clips are paired with generate-qwen-naturalness-benchmark.py for blinded human listening.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

const outputRoot = resolve(option('--output', 'data/offline-backfill/tts-naturalness-benchmark/mimo'));
const sentenceLimit = Math.max(0, Number(option('--sentence-limit', '0')) || 0);
const ffmpeg = option('--ffmpeg', process.env.FFMPEG_BIN || '/Users/cjs/.local/bin/ffmpeg');
const apiKey = envValue('DEEPINFRA_API_KEY');
if (!apiKey) throw new Error('DEEPINFRA_API_KEY is required');
mkdirSync(outputRoot, { recursive: true });

const entries = [];
for (const [sentenceIndex, text] of TEST_SENTENCES.slice(0, sentenceLimit || undefined).entries()) {
  const digest = createHash('sha256').update(`mimo-v2.5-mia\n${text}`).digest('hex');
  const audioPath = resolve(outputRoot, `${digest}.mp3`);
  if (!existsSync(audioPath)) {
    const response = spawnSync('curl', [
      '--fail', '--silent', '--show-error', '--max-time', '120', MIMO_URL,
      '-H', `Authorization: Bearer ${apiKey}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', JSON.stringify({ text, voice: 'Mia', output_format: 'wav' }),
    ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (response.status !== 0) throw new Error(`MiMo request failed: ${response.stderr.slice(-1_000)}`);
    const payload = JSON.parse(response.stdout);
    const encoded = String(payload.audio || '').replace(/^data:[^,]*,/, '');
    if (!encoded) throw new Error('MiMo returned no audio');
    const wavPath = resolve(outputRoot, `${digest}.wav`);
    writeFileSync(wavPath, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    const transcode = spawnSync(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath,
      '-af', 'loudnorm=I=-18:TP=-2:LRA=7', '-ar', '24000', '-ac', '1', '-b:a', '96k', audioPath,
    ], { encoding: 'utf8', timeout: 90_000 });
    unlinkSync(wavPath);
    if (transcode.status !== 0) throw new Error(`ffmpeg failed: ${transcode.stderr.slice(-1_000)}`);
  }
  entries.push({ sentenceIndex, text, recipe: 'mimo-v2.5-mia', file: audioPath.split('/').at(-1) });
  process.stderr.write(`[${sentenceIndex + 1}/${sentenceLimit || TEST_SENTENCES.length}] MiMo Mia\n`);
}

const manifestPath = resolve(outputRoot, 'manifest.json');
const temporaryPath = `${manifestPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify({
  version: 1,
  generatedAt: Date.now(),
  model: 'XiaomiMiMo/MiMo-V2.5-tts',
  entries,
}, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, manifestPath);
