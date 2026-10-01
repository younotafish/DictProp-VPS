#!/usr/bin/env node

// Encrypts and decrypts the bundles that cross between this Mac and production through GitHub: release
// assets on the way in, workflow artifacts on the way out. Both live on a public repository, so every
// blob is AES-256-GCM under a key derived from SENTENCE_BRIDGE_KEY, and its associated data names the
// operation it was made for, so a blob made for one import or export is refused by every other.
//
// Format: "DPB1" | 16-byte salt | 12-byte IV | ciphertext | 16-byte GCM tag.
// Decryption writes only to a private temp file beside the output and renames it into place once the
// tag verifies, so a wrong key, a wrong purpose, a truncated download or a flipped byte leaves nothing.

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import {
  createReadStream, createWriteStream, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

export const MAGIC = Buffer.from('DPB1', 'ascii');
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
export const PBKDF2_ITERATIONS = 600_000;
const PURPOSE_PATTERN = /^[A-Za-z0-9._:-]{1,300}$/;
const pbkdf2Async = promisify(pbkdf2);

export class BridgeCryptoError extends Error {}

export function defaultKeyFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dictprop', 'sentence_bridge_key');
}

// The key is the first line of the key file, as `openssl -pass file:` read it, so the same key file
// and the SENTENCE_BRIDGE_KEY secret keep working across the format change.
export function normalizeKey(text) {
  const key = String(text ?? '').split(/\r?\n/, 1)[0];
  if (!key) throw new BridgeCryptoError('SENTENCE_BRIDGE_KEY is empty');
  return key;
}

export function loadKey({ keyFile = '', env = process.env } = {}) {
  if (keyFile) return normalizeKey(readFileSync(keyFile, 'utf8'));
  if (env.SENTENCE_BRIDGE_KEY) return normalizeKey(env.SENTENCE_BRIDGE_KEY);
  return normalizeKey(readFileSync(defaultKeyFile(), 'utf8'));
}

function checkPurpose(purpose) {
  if (!PURPOSE_PATTERN.test(String(purpose ?? ''))) {
    throw new BridgeCryptoError(`invalid purpose ${JSON.stringify(purpose)}`);
  }
  return Buffer.from(purpose, 'utf8');
}

function deriveKey(passphrase, salt) {
  return pbkdf2Async(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

export async function* encryptChunks(source, { passphrase, purpose }) {
  const purposeBytes = checkPurpose(purpose);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([header, purposeBytes]));
  yield header;
  for await (const chunk of source) {
    const encrypted = cipher.update(chunk);
    if (encrypted.length) yield encrypted;
  }
  const last = cipher.final();
  if (last.length) yield last;
  yield cipher.getAuthTag();
}

// The last TAG_BYTES of the stream are held back until the input ends, since only then is it known
// which bytes are the tag. Plaintext chunks are yielded before the tag is checked, so callers must
// treat everything yielded as provisional until the generator finishes without throwing.
export async function* decryptChunks(source, { passphrase, purpose }) {
  const purposeBytes = checkPurpose(purpose);
  let pending = Buffer.alloc(0);
  let decipher = null;
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    if (!decipher) {
      if (pending.length >= MAGIC.length && !pending.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new BridgeCryptoError('not a DPB1 bridge blob');
      }
      if (pending.length < HEADER_BYTES) continue;
      const header = pending.subarray(0, HEADER_BYTES);
      const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
      const iv = header.subarray(MAGIC.length + SALT_BYTES);
      decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.concat([header, purposeBytes]));
      pending = pending.subarray(HEADER_BYTES);
    }
    if (pending.length > TAG_BYTES) {
      const decrypted = decipher.update(pending.subarray(0, pending.length - TAG_BYTES));
      pending = Buffer.from(pending.subarray(pending.length - TAG_BYTES));
      if (decrypted.length) yield decrypted;
    }
  }
  if (!decipher) {
    throw new BridgeCryptoError(pending.length >= MAGIC.length
      ? 'truncated bridge blob: incomplete header'
      : 'not a DPB1 bridge blob');
  }
  if (pending.length < TAG_BYTES) throw new BridgeCryptoError('truncated bridge blob: missing authentication tag');
  decipher.setAuthTag(pending);
  let last;
  try {
    last = decipher.final();
  } catch {
    throw new BridgeCryptoError('bridge blob failed authentication: wrong key or purpose, or damaged data');
  }
  if (last.length) yield last;
}

// Temp files are created exclusively and private, and removed on failure and on SIGINT/SIGTERM/SIGHUP,
// so an interrupted run leaves neither plaintext nor a half-written blob behind.
const liveTempFiles = new Set();
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let signalHandlersInstalled = false;

function installSignalCleanup() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      for (const path of liveTempFiles) rmSync(path, { force: true });
      process.exit(code);
    });
  }
}

function tempPathFor(outputPath, label) {
  return join(dirname(outputPath), `.${basename(outputPath)}.${label}-${process.pid}-${randomBytes(6).toString('hex')}`);
}

// The names of decryption's temp files. A SIGKILL skips the cleanup above and leaves one behind,
// plaintext and all, so the cycle's sweep removes those a day old (bridge-leftovers.mjs temp-files).
export const DECRYPTION_TEMP_PATTERN = /^\..+\.(?:decrypting|gunzipping)-\d+-[0-9a-f]{12}$/;

async function writePrivately(outputPath, label, write) {
  const tempPath = tempPathFor(outputPath, label);
  // Opened synchronously, so the file exists before anything can fail and the cleanup below always finds it.
  const fd = openSync(tempPath, 'wx', 0o600);
  liveTempFiles.add(tempPath);
  try {
    await write(createWriteStream(tempPath, { fd, flush: true }));
    return tempPath;
  } catch (error) {
    rmSync(tempPath, { force: true });
    liveTempFiles.delete(tempPath);
    throw error;
  }
}

function commit(tempPath, outputPath) {
  renameSync(tempPath, outputPath);
  liveTempFiles.delete(tempPath);
}

function discard(tempPath) {
  rmSync(tempPath, { force: true });
  liveTempFiles.delete(tempPath);
}

export async function encryptFile({ input, output, passphrase, purpose }) {
  checkPurpose(purpose);
  const outputPath = resolve(output);
  installSignalCleanup();
  const tempPath = await writePrivately(outputPath, 'encrypting', sink =>
    pipeline(input ?? process.stdin, source => encryptChunks(source, { passphrase, purpose }), sink));
  commit(tempPath, outputPath);
  return outputPath;
}

// With gunzip, the whole blob is authenticated before a single byte is decompressed, so nothing
// unauthenticated ever reaches the decompressor.
export async function decryptFile({ input, output, passphrase, purpose, gunzip = false }) {
  checkPurpose(purpose);
  const outputPath = resolve(output);
  installSignalCleanup();
  const authenticated = await writePrivately(outputPath, 'decrypting', sink =>
    pipeline(input ?? process.stdin, source => decryptChunks(source, { passphrase, purpose }), sink));
  if (!gunzip) {
    commit(authenticated, outputPath);
    return outputPath;
  }
  try {
    const decompressed = await writePrivately(outputPath, 'gunzipping', sink =>
      pipeline(createReadStream(authenticated), createGunzip(), sink));
    commit(decompressed, outputPath);
  } finally {
    discard(authenticated);
  }
  return outputPath;
}

const USAGE = 'Usage: bridge-crypto.mjs <encrypt|decrypt> --purpose <label> --out <file> ' +
  '[--in <file>] [--key-file <file>] [--gunzip (decrypt only)]\n' +
  'The key comes from --key-file, else $SENTENCE_BRIDGE_KEY, else ' +
  '${XDG_CONFIG_HOME:-~/.config}/dictprop/sentence_bridge_key.';

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        purpose: { type: 'string' },
        out: { type: 'string' },
        in: { type: 'string' },
        'key-file': { type: 'string' },
        gunzip: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const { positionals: [command, ...extra], values } = parsed;
  if (!['encrypt', 'decrypt'].includes(command) || extra.length || !values.purpose || !values.out ||
      (values.gunzip && command !== 'decrypt')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const passphrase = loadKey({ keyFile: values['key-file'] });
    const input = values.in ? createReadStream(values.in) : process.stdin;
    const options = { input, output: values.out, passphrase, purpose: values.purpose };
    const outputPath = command === 'encrypt'
      ? await encryptFile(options)
      : await decryptFile({ ...options, gunzip: values.gunzip });
    const { size } = statSync(outputPath);
    process.stderr.write(`bridge-crypto: ${command}ed ${size} bytes for ${values.purpose}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof BridgeCryptoError ? error.message : `${error.code ?? 'error'}: ${error.message}`;
    process.stderr.write(`bridge-crypto: ${command} failed: ${message}\n`);
    return 1;
  }
}

// Node runs the main module from its real path, so compare real paths when deciding to act as a CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
