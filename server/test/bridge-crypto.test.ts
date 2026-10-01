import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import {
  BridgeCryptoError,
  DECRYPTION_TEMP_PATTERN,
  HEADER_BYTES,
  MAGIC,
  TAG_BYTES,
  decryptFile,
  encryptFile,
  loadKey,
} from '../../scripts/offline/bridge-crypto.mjs';
import { selectDecryptionTempFiles } from '../../scripts/offline/bridge-leftovers.mjs';

const script = fileURLToPath(new URL('../../scripts/offline/bridge-crypto.mjs', import.meta.url));
const passphrase = 'correct horse battery staple';
const purpose = 'import:corpus-import:corpus-audit-wave-0001-20261001T120000Z';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-crypto-'));
}

async function encryptBytes(dir: string, plaintext: Buffer, options: { purpose?: string; key?: string } = {}) {
  const output = join(dir, 'blob.dpb');
  await encryptFile({
    input: Readable.from([plaintext]),
    output,
    passphrase: options.key ?? passphrase,
    purpose: options.purpose ?? purpose,
  });
  return readFileSync(output);
}

async function decryptBytes(dir: string, blob: Buffer, options: { purpose?: string; key?: string; gunzip?: boolean } = {}) {
  const input = join(dir, 'input.dpb');
  writeFileSync(input, blob);
  const output = join(dir, 'plain.out');
  await decryptFile({
    input: createReadStream(input),
    output,
    passphrase: options.key ?? passphrase,
    purpose: options.purpose ?? purpose,
    gunzip: options.gunzip,
  });
  return { output, plaintext: readFileSync(output) };
}

// Everything in the directory except the files the test itself wrote.
function leftovers(dir: string, expected: string[]): string[] {
  return readdirSync(dir).filter(name => !expected.includes(name));
}

async function assertRefused(blob: Buffer, pattern: RegExp, options: { purpose?: string; key?: string } = {}) {
  const dir = tempDir();
  try {
    await assert.rejects(decryptBytes(dir, blob, options), error =>
      error instanceof BridgeCryptoError && pattern.test(error.message));
    assert.deepEqual(leftovers(dir, ['input.dpb']), [], 'a refused blob leaves no output or temp file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a blob round-trips through a private file and has the DPB1 layout', async () => {
  const dir = tempDir();
  try {
    const plaintext = randomBytes(200_000);
    const blob = await encryptBytes(dir, plaintext);
    assert.deepEqual(blob.subarray(0, 4), MAGIC);
    assert.equal(blob.length, HEADER_BYTES + plaintext.length + TAG_BYTES);
    assert.equal(statSync(join(dir, 'blob.dpb')).mode & 0o777, 0o600);
    assert.equal(blob.indexOf(plaintext.subarray(0, 64)), -1, 'the plaintext does not appear in the blob');

    const { output, plaintext: decrypted } = await decryptBytes(dir, blob);
    assert.deepEqual(decrypted, plaintext);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(dir, ['blob.dpb', 'input.dpb', 'plain.out']), []);

    const again = await encryptBytes(dir, plaintext);
    assert.notDeepEqual(again.subarray(4, HEADER_BYTES), blob.subarray(4, HEADER_BYTES), 'salt and IV are fresh each time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty plaintext and a multi-megabyte stream both round-trip', async () => {
  const dir = tempDir();
  try {
    assert.deepEqual((await decryptBytes(dir, await encryptBytes(dir, Buffer.alloc(0)))).plaintext, Buffer.alloc(0));
    const chunks = Array.from({ length: 48 }, () => randomBytes(100_003));
    const output = join(dir, 'big.dpb');
    await encryptFile({ input: Readable.from(chunks), output, passphrase, purpose });
    const { plaintext } = await decryptBytes(dir, readFileSync(output));
    assert.deepEqual(plaintext, Buffer.concat(chunks));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flipping one byte in any region of the blob is refused', async () => {
  const dir = tempDir();
  let blob: Buffer;
  try {
    blob = await encryptBytes(dir, randomBytes(4_096));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const regions: Array<[string, number, RegExp]> = [
    ['magic', 1, /not a DPB1 bridge blob/],
    ['salt', 4 + 7, /failed authentication/],
    ['iv', 4 + 16 + 5, /failed authentication/],
    ['first ciphertext byte', HEADER_BYTES, /failed authentication/],
    ['last ciphertext byte', blob.length - TAG_BYTES - 1, /failed authentication/],
    ['tag', blob.length - 3, /failed authentication/],
  ];
  for (const [region, offset, pattern] of regions) {
    const tampered = Buffer.from(blob);
    tampered[offset] ^= 0x01;
    await assertRefused(tampered, pattern).catch(error => {
      throw new Error(`${region}: ${error.message}`);
    });
  }
});

test('a blob is refused under another purpose or another key', async () => {
  const dir = tempDir();
  let blob: Buffer;
  try {
    blob = await encryptBytes(dir, Buffer.from('{"items":[]}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assertRefused(blob, /failed authentication/, { purpose: 'import:essay-import:corpus-audit-wave-0001-20261001T120000Z' });
  await assertRefused(blob, /failed authentication/, { purpose: 'import:corpus-import:corpus-audit-wave-0002-20261001T120000Z' });
  await assertRefused(blob, /failed authentication/, { purpose: 'corpus-export' });
  await assertRefused(blob, /failed authentication/, { key: `${passphrase}!` });
});

test('truncated input is refused at every length', async () => {
  const dir = tempDir();
  let blob: Buffer;
  try {
    blob = await encryptBytes(dir, randomBytes(1_000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assertRefused(Buffer.alloc(0), /not a DPB1 bridge blob/);
  await assertRefused(blob.subarray(0, 3), /not a DPB1 bridge blob/);
  await assertRefused(blob.subarray(0, 20), /incomplete header/);
  await assertRefused(blob.subarray(0, HEADER_BYTES + 5), /missing authentication tag/);
  await assertRefused(blob.subarray(0, blob.length - 1), /failed authentication/);
  await assertRefused(blob.subarray(0, 600), /failed authentication/);
});

test('a failed decryption leaves an existing output untouched', async () => {
  const dir = tempDir();
  try {
    const blob = Buffer.from(await encryptBytes(dir, randomBytes(3_000_000)));
    blob[blob.length - 1] ^= 0xff;
    writeFileSync(join(dir, 'plain.out'), 'previous corpus');
    await assert.rejects(decryptBytes(dir, blob), /failed authentication/);
    assert.equal(readFileSync(join(dir, 'plain.out'), 'utf8'), 'previous corpus');
    assert.deepEqual(leftovers(dir, ['blob.dpb', 'input.dpb', 'plain.out']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gunzip runs only after the blob authenticates', async () => {
  const dir = tempDir();
  try {
    const json = Buffer.from(JSON.stringify({ items: Array.from({ length: 500 }, (_, index) => ({ index })) }));
    const blob = await encryptBytes(dir, gzipSync(json));
    assert.deepEqual((await decryptBytes(dir, blob, { gunzip: true })).plaintext, json);

    rmSync(join(dir, 'plain.out'));
    const notGzip = await encryptBytes(dir, Buffer.from('plain text, not gzip'));
    await assert.rejects(decryptBytes(dir, notGzip, { gunzip: true }), /incorrect header check|Z_DATA_ERROR/);
    assert.deepEqual(leftovers(dir, ['blob.dpb', 'input.dpb']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the key is the first line of the key file and matches the same value from the environment', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'key'), 'secret-value\nignored second line\n');
    assert.equal(loadKey({ keyFile: join(dir, 'key'), env: {} }), 'secret-value');
    assert.equal(loadKey({ env: { SENTENCE_BRIDGE_KEY: 'secret-value' } }), 'secret-value');
    writeFileSync(join(dir, 'empty'), '\n');
    assert.throws(() => loadKey({ keyFile: join(dir, 'empty'), env: {} }), /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI encrypts from stdin with a key file and decrypts with the key from the environment', () => {
  const dir = tempDir();
  try {
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, `${passphrase}\n`);
    const plaintext = Buffer.from('{"secret":"plaintext that must never reach a log"}');
    const blob = join(dir, 'export.dpb');
    const encrypted = spawnSync(process.execPath, [script, 'encrypt', '--key-file', keyFile, '--purpose', 'corpus-export:123', '--out', blob], {
      input: gzipSync(plaintext),
      env: { ...process.env, SENTENCE_BRIDGE_KEY: '' },
    });
    assert.equal(encrypted.status, 0, encrypted.stderr.toString());
    assert.equal(encrypted.stdout.length, 0);

    const output = join(dir, 'export.json');
    const env = { ...process.env, SENTENCE_BRIDGE_KEY: passphrase, XDG_CONFIG_HOME: join(dir, 'nowhere') };
    const decrypted = spawnSync(process.execPath, [script, 'decrypt', '--gunzip', '--purpose', 'corpus-export:123', '--in', blob, '--out', output], { env });
    assert.equal(decrypted.status, 0, decrypted.stderr.toString());
    assert.equal(decrypted.stdout.length, 0, 'decryption never writes to stdout');
    assert.deepEqual(readFileSync(output), plaintext);
    assert.doesNotMatch(decrypted.stderr.toString(), /plaintext that must never/);

    const replayed = spawnSync(process.execPath, [script, 'decrypt', '--gunzip', '--purpose', 'corpus-export:124', '--in', blob, '--out', join(dir, 'other.json')], { env });
    assert.equal(replayed.status, 1);
    assert.match(replayed.stderr.toString(), /failed authentication/);
    assert.deepEqual(leftovers(dir, ['key', 'export.dpb', 'export.json']), []);

    const usage = spawnSync(process.execPath, [script, 'decrypt', '--purpose', 'x'], { env });
    assert.equal(usage.status, 2);
    const badPurpose = spawnSync(process.execPath, [script, 'encrypt', '--purpose', 'has space', '--out', join(dir, 'x')], { env, input: '' });
    assert.equal(badPurpose.status, 1);
    assert.match(badPurpose.stderr.toString(), /invalid purpose/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Starts the CLI on half a blob and returns once the decryption has written plaintext to its temp file.
// The exit resolves to the exit code, or to the signal when the process could not handle it.
async function decryptionMidStream(dir: string) {
  const blob = await encryptBytes(dir, randomBytes(2_000_000));
  const child = spawn(process.execPath, [script, 'decrypt', '--purpose', purpose, '--out', join(dir, 'plain.out')], {
    env: { ...process.env, SENTENCE_BRIDGE_KEY: passphrase },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const exited = new Promise<number | string | null>(resolve => child.on('exit', (code, signal) => resolve(code ?? signal)));
  // The kill that ends it closes the pipe while part of the write may still be buffered; that EPIPE is expected.
  child.stdin.on('error', () => {});
  child.stdin.write(blob.subarray(0, blob.length / 2));
  const deadline = Date.now() + 10_000;
  const partial = () => readdirSync(dir).find(name => name.startsWith('.plain.out.decrypting-'));
  while (!partial() || statSync(join(dir, partial()!)).size === 0) {
    assert.ok(Date.now() < deadline, 'the decryption started writing its temp file');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, exited };
}

test('a decryption killed mid-stream removes its partial plaintext', async () => {
  const dir = tempDir();
  try {
    const { child, exited } = await decryptionMidStream(dir);
    child.kill('SIGTERM');
    assert.equal(await exited, 143);
    assert.deepEqual(leftovers(dir, ['blob.dpb']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decryption killed outright leaves its temp file, which the cycle sweep removes once a day old', async () => {
  const dir = tempDir();
  try {
    const { child, exited } = await decryptionMidStream(dir);
    // SIGKILL cannot be handled, so the cleanup never runs.
    child.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');
    const [left, ...rest] = leftovers(dir, ['blob.dpb']);
    assert.deepEqual(rest, []);
    assert.match(left, DECRYPTION_TEMP_PATTERN);
    assert.deepEqual(selectDecryptionTempFiles([dir]), []);
    const dayLater = Date.now() + 25 * 60 * 60 * 1_000;
    assert.deepEqual(selectDecryptionTempFiles([dir], { now: dayLater }).map(({ path }: { path: string }) => path), [join(dir, left)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
