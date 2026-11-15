import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessError, runProcess } from '../src/tts/process.js';
import { transcodeToMp3 } from '../src/tts/synthesis.js';

const node = process.execPath;
const bin = mkdtempSync(join(tmpdir(), 'dictprop-tts-process-'));
// Stand-ins for ffmpeg: one passes its input through (prefixed, so the output differs), one fails, one prints nothing.
const script = (name: string, body: string): string => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
};
const echoingFfmpeg = script('ffmpeg-ok', 'printf MP3:; cat');
const failingFfmpeg = script('ffmpeg-fail', 'echo "Invalid data found when processing input" >&2; exit 1');
const silentFfmpeg = script('ffmpeg-silent', 'cat > /dev/null');
const reason = (expected: ProcessError['reason']) => (error: unknown) =>
  error instanceof ProcessError && error.reason === expected;

test('a process that succeeds hands back the stdout it was asked to capture, fed from its input', async () => {
  const result = await runProcess(node, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input: Buffer.from('bytes in'), timeoutMs: 10_000, captureStdout: true,
  });
  assert.equal(result.stdout.toString(), 'bytes in');
  const discarded = await runProcess(node, ['-e', 'process.stdout.write("ignored")'], { timeoutMs: 10_000 });
  assert.equal(discarded.stdout.length, 0);
});

test('a non-zero exit rejects with the end of stderr in the message', async () => {
  await assert.rejects(
    runProcess(node, ['-e', 'process.stderr.write("x".repeat(30000) + "the real cause"); process.exit(3)'], { timeoutMs: 10_000 }),
    (error: unknown) => reason('exit')(error) && /exited with 3: x*the real cause$/.test((error as Error).message) &&
      (error as ProcessError).stderr.length === 20_000,
  );
});

test('a process that runs past its time limit is killed', async () => {
  const started = Date.now();
  await assert.rejects(runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    (error: unknown) => reason('timeout')(error) && /exceeded 200ms$/.test((error as Error).message));
  assert.ok(Date.now() - started < 10_000);
});

test('a command that does not exist rejects as a failed start', async () => {
  await assert.rejects(runProcess(join(bin, 'no-such-command'), [], { timeoutMs: 10_000 }), reason('spawn'));
});

test('transcoding keeps the WAV when ffmpeg is missing, fails or prints nothing, and uses its output otherwise', async () => {
  const wav = Buffer.from('RIFF fake wav bytes');
  assert.equal((await transcodeToMp3(wav, echoingFfmpeg)).toString(), 'MP3:RIFF fake wav bytes');
  assert.equal(await transcodeToMp3(wav, join(bin, 'no-such-ffmpeg')), wav);
  assert.equal(await transcodeToMp3(wav, failingFfmpeg), wav);
  assert.equal(await transcodeToMp3(wav, silentFfmpeg), wav);
});
