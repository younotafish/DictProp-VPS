import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';
import { readRepoFile } from '../support/paths.ts';

const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();

const tts = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api/tts.ts');
const { SentenceSpeakerButton } = await import('../../components/SentenceSpeakerButton.tsx');
const { SentenceHero } = await import('../../views/detail/SentenceHero.tsx');

type ButtonProps = Omit<Parameters<typeof SentenceSpeakerButton>[0], 'text'>;
const render = (text: string, props: ButtonProps = {}) => renderToStaticMarkup(createElement(SentenceSpeakerButton, { text, ...props }));
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

test('the props for other owners (onToggle, allowDownload, stopOnUnmount, onPlaybackStart) leave the markup as it was', () => {
  const plain = render(SENTENCE);
  assert.equal(render(SENTENCE, { onToggle: () => {}, allowDownload: false, stopOnUnmount: false, onPlaybackStart: () => {} }), plain);
  assert.equal(render(SENTENCE, { tone: 'light' }), plain, 'light is the default tone');
});

test('the dark tone draws the icon white in every state, for a dark button the caller styles', async () => {
  const dark = (props: ButtonProps = {}) => render(SENTENCE, { tone: 'dark', iconSize: 26, className: 'w-16 h-16 rounded-full bg-slate-900', ...props });
  let markup = dark();
  assert.match(markup, /class=" transition-colors text-white w-16 h-16 rounded-full bg-slate-900"/);
  assert.doesNotMatch(markup, /text-indigo/);
  assert.match(markup, /<svg[^>]* width="26" height="26"/, 'iconSize sizes the icon');
  assert.equal(labelOf(markup), 'Listen to this sentence');

  server.clips.set(await ttsKey(PLAIN, 'Mia'), new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }));
  tts.speakNatural(PLAIN, { allowDownload: true });
  const el = media.element();
  await until(() => el.src.startsWith('blob:') && !el.paused, 'the clip plays');
  el.startPlaying();
  markup = dark();
  assert.equal(labelOf(markup), 'Pause');
  assert.match(markup, /class=" transition-colors text-white w-16/);
  assert.doesNotMatch(markup, /text-indigo/);
  tts.stopCurrent();
});

test('the sentence hero around the button marks Command-held look-up with the class the stylesheet styles', () => {
  const hero = (layout: 'split' | 'centered', commandHeld: boolean) => renderToStaticMarkup(createElement(SentenceHero, {
    layout, text: SENTENCE, sourceWord: 'sentence', onSearchWord: () => {}, commandHeld,
    onWordClickCapture: () => {}, onListened: () => {}, copyState: null, onCopy: () => {},
  })).match(/<p data-sentence-hero="[^"]*" class="([^"]*)"/)?.[1] ?? '';
  for (const layout of ['split', 'centered'] as const) {
    assert.ok(hero(layout, true).split(' ').includes('sentence-command-lookup-active'), layout);
    assert.ok(!hero(layout, false).includes('sentence-command'), layout);
  }
  const css = readRepoFile('src/index.css');
  assert.match(css, /^\.sentence-command-lookup-active \[data-word-offset\] \{/m);
  assert.match(css, /^\.sentence-command-lookup-active \[data-word-offset\]:hover \{/m);
  assert.doesNotMatch(css, /seek-active/);
});
