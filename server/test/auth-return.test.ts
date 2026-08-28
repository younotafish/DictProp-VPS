import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAuthReturnTo } from '../src/auth-return.js';

test('OAuth return targets are limited to the private trip site', () => {
  assert.equal(sanitizeAuthReturnTo('/lake-loop-26/'), '/lake-loop-26/');
  assert.equal(
    sanitizeAuthReturnTo('/lake-loop-26/day?view=compact#hotel'),
    '/lake-loop-26/day?view=compact#hotel',
  );
  assert.equal(sanitizeAuthReturnTo(undefined), '/');
  assert.equal(sanitizeAuthReturnTo('/api/auth/logout'), '/');
  assert.equal(sanitizeAuthReturnTo('//evil.example/lake-loop-26/'), '/');
  assert.equal(sanitizeAuthReturnTo('https://evil.example/lake-loop-26/'), '/');
});
