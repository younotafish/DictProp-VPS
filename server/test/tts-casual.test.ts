import assert from 'node:assert/strict';
import test from 'node:test';
import { AiError, createChatClient, createChatTextClient, type FetchLike } from '../src/ai-client.js';
import { cleanCasualRespelling, reduceCasualBatch, reduceToCasual } from '../src/tts/casual.js';
import { httpStatus, reply, type Responder } from './support/ai.js';

// DeepInfra's chat API answered from a script (the last answer repeats), with each request body recorded.
function chat(...responders: Responder[]) {
  const bodies: any[] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    return responders[Math.min(bodies.length, responders.length) - 1](init);
  };
  const options = { fetch, apiKey: () => 'test-key', retryDelayMs: 0 };
  return { text: createChatTextClient(options), json: createChatClient(options), bodies };
}

test('one sentence is respelled with a plain-text request and comes back without wrapping quotes', async () => {
  const model = chat(reply('"I\'m gonna head home."'));
  assert.equal(await reduceToCasual('I am going to head home.', model.text), "I'm gonna head home.");
  assert.equal(model.bodies.length, 1);
  const [body] = model.bodies;
  assert.equal(body.model, 'deepseek-ai/DeepSeek-V4-Flash');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 800);
  assert.equal('response_format' in body, false);
  assert.match(body.messages[0].content, /^Respell an English sentence/);
  assert.equal(body.messages[1].content, 'I am going to head home.');
});

test('a respelling that is cut off, refused or empty is a failure, never a clear line voiced as casual', async () => {
  assert.equal(await reduceToCasual('A long sentence.', chat(reply('A long sen', 'length')).text), null);
  assert.equal(await reduceToCasual('A sentence.', chat(httpStatus(402, 'Payment Required')).text), null);
  assert.equal(await reduceToCasual('A sentence.', chat(reply('""')).text), null);
});

test('a batch is respelled with one numbered JSON request', async () => {
  const model = chat(reply({ lines: ['"I\'m gonna go."', "Lemme see."] }));
  assert.deepEqual(await reduceCasualBatch(['I am going to go.', 'Let me see.'], model.json), ["I'm gonna go.", 'Lemme see.']);
  const [body] = model.bodies;
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 4000);
  assert.equal(body.temperature, 0.3);
  assert.match(body.messages[0].content, /respond with JSON \{"lines":\[\.\.\.\]\} containing one respelled line per input/);
  assert.equal(body.messages[1].content, '1. I am going to go.\n2. Let me see.');
});

test('a batch reply with the wrong count or that keeps failing leaves every sentence to be respelled on its own', async () => {
  assert.deepEqual(await reduceCasualBatch(['One.', 'Two.'], chat(reply({ lines: ['Only one.'] })).json), [null, null]);
  const down = chat(httpStatus(503));
  assert.deepEqual(await reduceCasualBatch(['One.', 'Two.'], down.json), [null, null]);
  assert.equal(down.bodies.length, 2); // the chat client's one retry
});

test('a spent balance or a missing key rejects the batch, since no respelling can work for the rest of the run', async () => {
  await assert.rejects(reduceCasualBatch(['One.', 'Two.'], chat(httpStatus(402, 'Payment Required')).json),
    (error: unknown) => error instanceof AiError && error.kind === 'quota');
  const noKey = createChatClient({ fetch: async () => { throw new Error('no request expected'); }, apiKey: () => '' });
  await assert.rejects(reduceCasualBatch(['One.', 'Two.'], noKey), (error: unknown) => error instanceof AiError && error.kind === 'config');
});

test('casual respellings lose wrapping quotes but keep their apostrophes', () => {
  assert.equal(cleanCasualRespelling('"I\'m gonna go."'), "I'm gonna go.");
  assert.equal(cleanCasualRespelling('“Goin\' home, ya know”'), "Goin' home, ya know");
  assert.equal(cleanCasualRespelling("'cause I said so, that's why"), "'cause I said so, that's why");
  assert.equal(cleanCasualRespelling("  gimme a sec  "), 'gimme a sec');
  assert.equal(cleanCasualRespelling('""'), null);
  assert.equal(cleanCasualRespelling('   '), null);
  assert.equal(cleanCasualRespelling(42), null);
});
