import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createChunkedWriter } from '../src/scripts/support/chunked-writer.js';

/** A stream that takes each chunk a tick later, as a pipe to a slower reader does, and records what it was given. */
function slowStream() {
  const chunks: string[] = [];
  let mostBuffered = 0;
  const stream = new Writable({
    highWaterMark: 8,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      setImmediate(done);
    },
  });
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    const accepted = write(chunk);
    mostBuffered = Math.max(mostBuffered, stream.writableLength);
    return accepted;
  }) as typeof stream.write;
  return { stream, chunks, mostBuffered: () => mostBuffered };
}

test('the writer batches small writes into chunks and waits for a full stream to drain', async () => {
  const { stream, chunks, mostBuffered } = slowStream();
  const writer = createChunkedWriter(stream, 10);
  const parts = Array.from({ length: 25 }, (_, index) => `[${index}]`);
  for (const part of parts) await writer.write(part);
  await writer.flush();
  await new Promise<void>(resolve => stream.end(resolve));

  assert.equal(chunks.join(''), parts.join(''));
  // Each chunk holds at least chunkSize characters, except the last.
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.length >= 10));
  assert.ok(chunks.length < parts.length);
  // Waiting for 'drain' keeps at most one chunk in the stream's buffer.
  assert.ok(mostBuffered() <= 14, `buffered ${mostBuffered()}`);
});

test('flushing an empty writer writes nothing', async () => {
  const { stream, chunks } = slowStream();
  const writer = createChunkedWriter(stream);
  await writer.flush();
  await writer.write('');
  await writer.flush();
  assert.deepEqual(chunks, []);
});
