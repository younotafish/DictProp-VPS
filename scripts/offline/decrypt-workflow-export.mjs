#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [logArg, markerArg, keyArg, outputArg] = process.argv.slice(2);
if (!logArg || !markerArg || !keyArg || !outputArg) {
  throw new Error('Usage: decrypt-workflow-export.mjs <workflow.log> <marker-prefix> <key-file> <output.json>');
}

const lines = readFileSync(resolve(logArg), 'utf8').split(/\r?\n/);
const beginMarker = `${markerArg}_BEGIN`;
const endMarker = `${markerArg}_END`;
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+(.*)$/;
const begin = lines.findIndex(line => timestampPattern.test(line) && line.trimEnd().endsWith(beginMarker));
const end = lines.findIndex((line, index) =>
  index > begin && timestampPattern.test(line) && line.trimEnd().endsWith(endMarker));
if (begin < 0 || end < 0) throw new Error(`Could not find ${beginMarker}/${endMarker} in workflow log`);

const base64 = lines.slice(begin + 1, end).map(line => {
  const timestamp = line.match(timestampPattern);
  return (timestamp ? timestamp[1] : line).trim();
}).filter(line => /^[A-Za-z0-9+/]+={0,2}$/.test(line)).join('');
if (!base64) throw new Error('Encrypted export payload is empty');

const encrypted = Buffer.from(base64, 'base64');
const decrypted = execFileSync('openssl', [
  'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', `file:${resolve(keyArg)}`,
], { input: encrypted, maxBuffer: 100 * 1024 * 1024 });
const json = gunzipSync(decrypted);
JSON.parse(json.toString('utf8'));
const outputPath = resolve(outputArg);
writeFileSync(outputPath, json, { mode: 0o600 });
chmodSync(outputPath, 0o600);
process.stderr.write(`Decrypted ${json.length} bytes to ${outputPath}\n`);
