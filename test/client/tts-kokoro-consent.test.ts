import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeTtsServer, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

// An Android phone: a missing clip would use the in-browser Kokoro voice, after asking before the big download.
const media = installFakeMedia({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
new FakeTtsServer().install();
let prompts = 0;
(globalThis as unknown as { window: { confirm: () => boolean } }).window.confirm = () => { prompts++; return false; };

const engine = await import('../../services/neuralTts.ts');

test('a declined download is not asked again this session: later misses go straight to the system voice', async () => {
  engine.speakNatural('The first sentence nobody has a clip for.', { allowDownload: true });
  await until(() => media.synth.last?.text === 'The first sentence nobody has a clip for.', 'the system voice reads the first');
  assert.equal(prompts, 1);
  engine.speakNatural('The second sentence nobody has a clip for.', { allowDownload: true });
  await until(() => media.synth.last?.text === 'The second sentence nobody has a clip for.', 'the system voice reads the second');
  assert.equal(prompts, 1);
});
