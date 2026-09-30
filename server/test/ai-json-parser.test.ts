import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelJson } from '../src/routes/ai.js';

test('malformed embedded model JSON uses the retryable parser error', () => {
  assert.deepEqual(parseModelJson('preface {"query":"bank"} suffix'), { query: 'bank' });
  assert.throws(
    () => parseModelJson("preface {'query':'bank'} suffix"),
    /Failed to parse JSON from DeepSeek response/,
  );
});

test('a whole-reply JSON value wins, so a fence or braces inside a string cannot derail it', () => {
  const reply = JSON.stringify({ query: 'code', grammar: 'Wrap it like ```js\n{ a: 1 }\n``` in Markdown.' });
  assert.deepEqual(parseModelJson(reply), JSON.parse(reply));
});

test('a fenced reply is unwrapped', () => {
  assert.deepEqual(parseModelJson('Here you go:\n```json\n{"query":"bank","vocabs":[]}\n```'), { query: 'bank', vocabs: [] });
});

test('trailing commas are removed only when nothing parses as written', () => {
  assert.deepEqual(parseModelJson('{"query":"bank","forms":["bank","banks",],}'), { query: 'bank', forms: ['bank', 'banks'] });
  // A comma inside a string is content, not a trailing comma.
  assert.deepEqual(parseModelJson('{"note":"a, }","list":[1,2,],}'), { note: 'a, }', list: [1, 2] });
});

test('with two top-level objects the larger answer beats a short draft', () => {
  const reply = 'Draft: {"query":"x"}\nFinal: {"query":"bank","vocabs":[{"word":"bank"}]}';
  assert.deepEqual(parseModelJson(reply), { query: 'bank', vocabs: [{ word: 'bank' }] });
});

test('an apostrophe in the surrounding prose does not hide the object', () => {
  assert.deepEqual(parseModelJson(`Here's the answer: {"query":"bank"} — hope it's useful`), { query: 'bank' });
});

test('a reply cut off mid-object still fails with the parser error', () => {
  assert.throws(() => parseModelJson('{"query":"bank","vocabs":[{"word":"bank","sense":"no'), /Failed to parse JSON/);
});
