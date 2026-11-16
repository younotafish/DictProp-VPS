import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeTtsServer, installFakeMedia } from '../support/audio/fakeMedia.ts';

// No IndexedDB here (iOS Safari's private mode, say).
installFakeMedia();
const server = new FakeTtsServer();
server.install();

let urlsOpened = 0;
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob: Blob) => { urlsOpened++; return realCreateObjectURL(blob); };
test.after(() => { URL.createObjectURL = realCreateObjectURL; });

const { preloadAudio } = await import('../../services/audio/clipWarmers.ts');
const { ttsKey } = await import('../../services/api/tts.ts');

test('without IndexedDB a session warm keeps its clips open in memory, as before', async () => {
  const texts = ['The first stored-nowhere sentence.', 'The second stored-nowhere sentence.'];
  for (const text of texts) server.clips.set(await ttsKey(text, 'Mia'), new Blob([new Uint8Array(8)]));
  const progress: string[] = [];
  await preloadAudio(texts, (done, total) => progress.push(`${done}/${total}`), { intoMemory: false });
  assert.equal(urlsOpened, 2);
  assert.equal(progress.at(-1), '2/2');
});
