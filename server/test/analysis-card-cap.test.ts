import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { FetchLike } from '../src/ai-client.js';
import { createAiRoutes } from '../src/routes/ai.js';

// The AI routes on a bare app, with DeepInfra answering one fixed reply.
function harness(content: unknown) {
  const requests: any[] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }));
  };
  const app = new Hono().route('/api', createAiRoutes({ fetch, apiKey: () => 'test-key', retryDelayMs: 0 }));
  const analyze = async (text: string) => {
    const response = await app.request('http://localhost/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  return { analyze, requests };
}

const card = (word: string, index: number) => ({
  word,
  sense: `noun: meaning number ${index}`,
  chinese: '意思',
  ipa: '/bæŋk/',
  definition: `The meaning numbered ${index} of the word, spelled out in full.`,
  forms: [word],
  wordFamily: [],
  synonyms: [],
  antonyms: [],
  confusables: [],
  examples: [
    `We talked about the {{${word}}} in meaning ${index} during lunch today.`,
    `Nobody expected the {{${word}}} to matter so much in case ${index}.`,
  ],
  history: 'An old word with a long and well-documented history of use.',
  register: 'Neutral; fine in speech and in writing.',
  mnemonic: `Picture meaning ${index} written on a card.`,
  imagePrompt: `A realistic everyday scene that shows meaning ${index} of the word, in natural daylight.`,
  usageAudit: { status: 'current_general', reason: 'Normal in American English.', confidence: 'high' },
});

test('a word gets at most 8 cards, the first 8 the model gave, and the prompt asks for no more', async () => {
  const h = harness({ query: 'bank', vocabs: Array.from({ length: 11 }, (_, index) => card('bank', index + 1)) });
  const body = await h.analyze('bank');
  assert.deepEqual(body.vocabs.map((vocab: any) => vocab.sense), Array.from({ length: 8 }, (_, index) => `noun: meaning number ${index + 1}`));
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].messages[0].content, /Give at most 8 cards/);
});

test('in a sentence the cap is per word, so other words keep their cards', async () => {
  const h = harness({
    query: 'We sat on the bank by the river all day.',
    translation: '我们在河岸边坐了一整天。',
    vocabs: [...Array.from({ length: 10 }, (_, index) => card('bank', index + 1)), card('river', 1), card('river', 2)],
  });
  const body = await h.analyze('We sat on the bank by the river all day.');
  const words = body.vocabs.map((vocab: any) => vocab.word);
  assert.equal(words.filter((word: string) => word === 'bank').length, 8);
  assert.equal(words.filter((word: string) => word === 'river').length, 2);
  assert.match(h.requests[0].messages[0].content, /at most 8 cards for any one word/);
});
