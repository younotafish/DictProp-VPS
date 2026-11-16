import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

// The results sheet's playback (components/search/useSheetPlayback.ts), run once through a server render and then
// through the real speech engine, with the browser's media and the server's clips faked.
installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();

const engine = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api/tts.ts');
const { useSheetPlayback } = await import('../../components/search/useSheetPlayback.ts');

let sentences = 0;
/** Two examples no earlier case has played, each with its clip on the server. */
const examples = async (): Promise<[string, string]> => {
  const pair: [string, string] = [`Example ${++sentences} reads first.`, `Example ${++sentences} reads second.`];
  for (const text of pair) server.clips.set(await ttsKey(text, 'Mia'), new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }));
  return pair;
};
const sheetPlayback = () => {
  let playback: ReturnType<typeof useSheetPlayback> | undefined;
  const Probe = () => { playback = useSheetPlayback('viewing'); return null; };
  renderToStaticMarkup(createElement(Probe));
  return playback!;
};
const state = () => engine.getPlaybackState();
/** The engine's <audio> element, not the silent loop the sheet's keep-alive plays on one of its own. */
const playerElement = () => {
  const el = FakeAudioElement.created.find(element => !element.loop);
  if (!el) throw new Error('the engine has not created its <audio> element yet');
  return el;
};
/** Waits for the read of `text` to reach the element and start, then puts it `played` of the way through its 4 s. */
const plays = async (text: string, played = 0) => {
  const el = playerElement();
  await until(() => state().text === text && el.src.startsWith('blob:') && !el.paused, `${text} plays`);
  el.loadMetadata(4);
  el.startPlaying();
  el.currentTime = 4 * played;
  assert.deepEqual(state(), { text, status: 'playing' });
};

test.beforeEach(() => { engine.stopCurrent(); });

test('E reads the examples in turn, and pressed again pauses or resumes, waits while one loads, and near the end starts the run again', async () => {
  const [first, second] = await examples();
  const playback = sheetPlayback();
  playback.readExamples([first, second]);
  await plays(first, 0.5);
  playback.readExamples([first, second]);
  assert.deepEqual(state(), { text: first, status: 'paused' });
  playback.readExamples([first, second]);
  assert.deepEqual(state(), { text: first, status: 'playing' });

  // The first ends, and after a breath the second loads: E leaves the load alone.
  playerElement().finish();
  await until(() => state().text === second, 'the second example loads');
  assert.equal(state().status, 'loading');
  playback.readExamples([first, second]);
  assert.deepEqual(state(), { text: second, status: 'loading' }, 'the read still loading carries on');

  await plays(second, 0.9);
  playback.readExamples([first, second]);
  assert.deepEqual(state(), { text: first, status: 'loading' }, 'at 85% or more the run starts again from the first example');
});
