import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();

const tts = await import('../../services/lazyTts.ts');
const { ttsKey } = await import('../../services/api.ts');
const { SentenceSpeakerButton } = await import('../../components/SentenceSpeakerButton.tsx');

const render = (text: string, props: { className?: string } = {}) => renderToStaticMarkup(createElement(SentenceSpeakerButton, { text, ...props }));
const labelOf = (markup: string) => markup.match(/aria-label="([^"]*)"/)?.[1];
const iconOf = (markup: string) => markup.match(/<svg[^>]* class="([^"]*)"/)?.[1];

const SENTENCE = 'The button reads this {{sentence}}.';
const PLAIN = 'The button reads this sentence.';

test('idle, the button offers to listen', () => {
  const markup = render(SENTENCE);
  assert.equal(labelOf(markup), 'Listen to this sentence');
  assert.equal(iconOf(markup), 'lucide lucide-volume2 lucide-volume-2');
  assert.match(markup, /class="p-2\.5 -m-2 transition-colors text-indigo-300 hover:text-indigo-600 "/);
  assert.match(markup, /title="Listen to this sentence"/);
  assert.match(markup, /^<button type="button"/);
});

test('the button follows its sentence through loading, playing and paused, and ignores other sentences', async () => {
  server.clips.set(await ttsKey(PLAIN, 'Mia'), new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }));
  tts.speakNatural(PLAIN, { allowDownload: true });
  await until(() => tts.getPlaybackState().status === 'loading', 'the engine loads and starts the request');
  let markup = render(SENTENCE);
  assert.equal(labelOf(markup), 'Loading natural voice');
  assert.equal(iconOf(markup), 'lucide lucide-loader-circle animate-spin');
  assert.equal(labelOf(render('Another sentence entirely.')), 'Listen to this sentence');

  const el = media.element();
  await until(() => el.src.startsWith('blob:') && !el.paused, 'the clip plays');
  el.startPlaying();
  markup = render(SENTENCE);
  assert.equal(labelOf(markup), 'Pause');
  assert.equal(iconOf(markup), 'lucide lucide-pause animate-pulse');
  assert.match(markup, /class="p-2\.5 -m-2 transition-colors text-indigo-500 "/);

  el.currentTime = 1;
  tts.pauseCurrent();
  markup = render(SENTENCE, { className: 'h-9 w-9' });
  assert.equal(labelOf(markup), 'Resume');
  assert.equal(iconOf(markup), 'lucide lucide-play');
  assert.match(markup, /class=" transition-colors text-indigo-500 h-9 w-9"/, 'a caller className replaces the default sizing');
  tts.stopCurrent();
  assert.equal(labelOf(render(SENTENCE)), 'Listen to this sentence');
});
