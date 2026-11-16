import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

// The review popup's audio (components/review/usePopupPlayback.ts), run once through a server render and then through
// the real speech engine, with the browser's media and the server's clips faked.
installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();

const engine = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api/tts.ts');
const { usePopupPlayback } = await import('../../components/review/usePopupPlayback.ts');

let sentences = 0;
/** Two examples no earlier case has played, each with its clip on the server. */
const examples = async (): Promise<[string, string]> => {
  const pair: [string, string] = [`Example ${++sentences} reads first.`, `Example ${++sentences} reads second.`];
  for (const text of pair) server.clips.set(await ttsKey(text, 'Mia'), new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }));
  return pair;
};
const popupAudio = (examplesList: readonly string[]) => {
  let audio: ReturnType<typeof usePopupPlayback> | undefined;
  const Probe = () => { audio = usePopupPlayback(examplesList); return null; };
  renderToStaticMarkup(createElement(Probe));
  return audio!;
};
const state = () => engine.getPlaybackState();
/** The engine's <audio> element, not the silent loop the popup's keep-alive plays on one of its own. */
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

test('Space waits for a read still loading, pauses and resumes what plays (near its end too), and with nothing playing reads the first example', async () => {
  const [first, second] = await examples();
  const audio = popupAudio([first, second]);
  audio.toggleSpeak(second);
  assert.deepEqual(state(), { text: second, status: 'loading' });
  audio.togglePlayback();
  assert.deepEqual(state(), { text: second, status: 'loading' }, 'the read still loading carries on');

  await plays(second, 0.5);
  audio.togglePlayback();
  assert.deepEqual(state(), { text: second, status: 'paused' });
  audio.togglePlayback();
  assert.deepEqual(state(), { text: second, status: 'playing' });
  playerElement().currentTime = 4 * 0.9;
  audio.togglePlayback();
  assert.deepEqual(state(), { text: second, status: 'paused' }, 'near its end it pauses too');

  engine.stopCurrent();
  audio.togglePlayback();
  assert.deepEqual(state(), { text: first, status: 'loading' });
});

test('E reads both examples in turn, and pressed again pauses or resumes, waits while one loads, and near the end starts the run again', async () => {
  const [first, second] = await examples();
  const audio = popupAudio([first, second]);
  audio.readBothExamples();
  await plays(first, 0.5);
  audio.readBothExamples();
  assert.deepEqual(state(), { text: first, status: 'paused' });
  audio.readBothExamples();
  assert.deepEqual(state(), { text: first, status: 'playing' });

  // The first ends, and after a breath the second loads: E leaves the load alone.
  playerElement().finish();
  await until(() => state().text === second, 'the second example loads');
  assert.equal(state().status, 'loading');
  audio.readBothExamples();
  assert.deepEqual(state(), { text: second, status: 'loading' }, 'the read still loading carries on');

  await plays(second, 0.9);
  audio.readBothExamples();
  assert.deepEqual(state(), { text: first, status: 'loading' }, 'at 85% or more the run starts again from the first example');
});
