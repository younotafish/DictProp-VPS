import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatClient, DEEPSEEK_MODEL } from '../src/ai-client.js';
import type { FetchLike } from '../src/proxy-fetch.js';
import { THEME_DOMAINS, THEMES } from '../src/shared/item-themes.js';
import { THEME_BOUNDARIES } from '../src/themes/boundaries.js';
import { classifyThemeBatch, THEME_SYSTEM_PROMPT, themeUserPrompt } from '../src/themes/classifier.js';
import type { ThemeItem } from '../src/themes/input.js';
import { hang, httpStatus, keepingAlive, reply, type Responder } from './support/ai.js';

/** A chat completion request to the model, as far as these tests read one. */
interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string };
  temperature: number;
  max_tokens?: number;
}

const [A, B, C] = THEMES.map(theme => theme.id);

/** The classifier on a chat client whose DeepInfra is a script of responses (the last one repeats). */
function harness(responders: Responder[]) {
  const requests: ChatRequest[] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    requests.push(JSON.parse(String(init.body)));
    return responders[Math.min(requests.length, responders.length) - 1](init);
  };
  const chat = createChatClient({ fetch, apiKey: () => 'test-key', retryDelayMs: 0 });
  /** The texts a request asked about, in its order. */
  const asked = (index: number) => [...requests[index].messages[1].content.matchAll(/^\d+\. \w+ (".*")$/gm)]
    .map(match => JSON.parse(match[1]) as string);
  return { chat, requests, asked };
}

const words = (count: number): ThemeItem[] => Array.from({ length: count }, (_, index) => ({ kind: 'word', text: `word ${index}` }));
/** A reply giving item n (from 1) the scene themes[n - 1]; null leaves it out. */
const answers = (...themes: Array<string | null>) => reply({ a: themes.flatMap((t, index) => (t ? [{ i: index + 1, t }] : [])) });

test('every theme in the taxonomy has a boundary note, and every note a theme', () => {
  assert.deepEqual(Object.keys(THEME_BOUNDARIES).sort(), THEMES.map(theme => theme.id).sort());
  for (const [id, note] of Object.entries(THEME_BOUNDARIES)) assert.ok(note.trim().length > 0, id);
});

test('the prompt lists every scene under its domain with its title, blurb and boundary, and numbers the items as JSON', () => {
  for (const domain of THEME_DOMAINS) {
    assert.ok(THEME_SYSTEM_PROMPT.includes(`\n${domain.title}\n`), domain.id);
    for (const theme of domain.themes) {
      assert.ok(THEME_SYSTEM_PROMPT.includes(`${theme.id} | ${theme.title} | ${theme.blurb} | ${THEME_BOUNDARIES[theme.id]}`), theme.id);
    }
  }
  assert.match(THEME_SYSTEM_PROMPT, /most naturally say or hear it/);
  assert.match(THEME_SYSTEM_PROMPT, /a setting or a role that has a scene of its own .* that scene wins/);
  assert.match(THEME_SYSTEM_PROMPT, /Never invent an id/);
  assert.match(THEME_SYSTEM_PROMPT, /\{"a":\[\{"i":1,"t":"scene-id"\}/);
  assert.equal(
    themeUserPrompt([{ kind: 'word', text: 'bank — noun: river — land beside a river' }, { kind: 'sentence', text: 'He said "go"\nnow.' }]),
    'Sort these 2 items. Each comes after its number and kind, as a JSON string.\n\n' +
      '1. word "bank — noun: river — land beside a river"\n2. sentence "He said \\"go\\"\\nnow."',
  );
});

test('a complete answer sorts the batch in one request, asked of DeepSeek in JSON mode at a low temperature', async () => {
  const h = harness([reply({ a: [{ i: 2, t: B }, { i: '1', t: ` ${A} ` }, { i: 3, t: A }] })]);
  const result = await classifyThemeBatch(words(3), h.chat);
  assert.deepEqual(result, { themes: [A, B, A], unanswered: [] });
  assert.equal(h.requests.length, 1);
  const [request] = h.requests;
  assert.equal(request.model, DEEPSEEK_MODEL);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.temperature, 0.1);
  assert.equal(request.max_tokens, 2_000);
  assert.equal(request.messages[0].content, THEME_SYSTEM_PROMPT);
  assert.deepEqual(h.asked(0), ['word 0', 'word 1', 'word 2']);
});

test('items a reply leaves out, contradicts or gives an unknown scene are asked again, then once more in a smaller request', async () => {
  const h = harness([
    reply({ a: [{ i: 1, t: A }, { i: 2, t: 'no-such-scene' }, { i: 3, t: B }, { i: 3, t: C }, { i: 9, t: A }] }),
    // The client's second asking: still short, but what it gives counts.
    answers(A, null, null, B),
    // The two items still without a scene go back on their own, numbered from 1.
    answers(C),
  ]);
  const result = await classifyThemeBatch(words(4), h.chat);
  assert.deepEqual(result, { themes: [A, C, null, B], unanswered: [2] });
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.asked(1), ['word 0', 'word 1', 'word 2', 'word 3']);
  assert.deepEqual(h.asked(2), ['word 1', 'word 2']);
});

test('a reply that can never be read sends the batch back in two halves, and the items they miss count', async () => {
  const h = harness([reply('not json at all'), reply('still not json'), answers(...words(30).map(() => A)), answers(B, null)]);
  const result = await classifyThemeBatch(words(60), h.chat);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.asked(2), words(30).map(item => item.text));
  assert.deepEqual(h.asked(3), words(60).slice(30).map(item => item.text));
  assert.deepEqual(result.themes.slice(0, 31), [...words(30).map(() => A), B]);
  assert.deepEqual(result.unanswered, words(60).slice(31).map((_item, index) => 31 + index));
  assert.equal(result.error, undefined);
});

test('a reply cut off at its token cap is not asked again whole: its items go back in halves', async () => {
  const h = harness([reply('{"a":[{"i":1,"t":', 'length'), answers(A), answers(B)]);
  const result = await classifyThemeBatch(words(2), h.chat);
  assert.deepEqual(result, { themes: [A, B], unanswered: [] });
  assert.equal(h.requests.length, 3);
});

test('a failure that is not the answer ends the batch with what it has, and no item counts as a miss', async () => {
  // The service is down: the client tries twice, then the batch stops.
  let h = harness([httpStatus(503)]);
  let result = await classifyThemeBatch(words(3), h.chat);
  assert.deepEqual(result.themes, [null, null, null]);
  assert.deepEqual(result.unanswered, []);
  assert.equal(result.error?.kind, 'unavailable');
  assert.equal(h.requests.length, 2);

  // A spent balance is not tried again.
  h = harness([httpStatus(402, 'insufficient balance')]);
  result = await classifyThemeBatch(words(3), h.chat);
  assert.equal(result.error?.kind, 'quota');
  assert.equal(h.requests.length, 1);

  // Down partway through the second asking: the scenes given so far stay, and only items asked in full can miss.
  h = harness([answers(A, null, null, null, null, null), answers(A, null, null, null, null, null), answers(B, null, null), httpStatus(503)]);
  result = await classifyThemeBatch(words(6), h.chat);
  assert.deepEqual(result.themes, [A, B, null, null, null, null]);
  assert.deepEqual(result.unanswered, [2, 3]);
  assert.equal(result.error?.kind, 'unavailable');
});

test('aborting a batch, as the server does when it shuts down, cancels the request under way', async () => {
  const h = harness([hang]);
  const controller = new AbortController();
  const pending = keepingAlive(() => classifyThemeBatch(words(2), h.chat, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.error?.kind, 'cancelled');
  assert.deepEqual(result.themes, [null, null]);
  assert.equal(h.requests.length, 1);
});

test('an empty batch asks nothing', async () => {
  const h = harness([answers()]);
  assert.deepEqual(await classifyThemeBatch([], h.chat), { themes: [], unanswered: [] });
  assert.equal(h.requests.length, 0);
});
