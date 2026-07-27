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
