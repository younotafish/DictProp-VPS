import assert from 'node:assert/strict';
import test from 'node:test';
import { STYLE_VOICES } from '../../services/audio/voices.ts';

test('each style plays and generates its own cache voice', () => {
  assert.deepEqual(STYLE_VOICES.clear, { play: ['Mia'], generate: 'Mia' });
  assert.deepEqual(STYLE_VOICES.casual, { play: ['casual'], generate: 'casual' });
});
