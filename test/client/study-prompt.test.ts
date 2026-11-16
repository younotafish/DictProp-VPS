import assert from 'node:assert/strict';
import test from 'node:test';
import { createClozePrompt } from '../../services/studyPrompt.ts';

test('cloze prompts hide marked inflections and strip secondary markers', () => {
  assert.equal(
    createClozePrompt('They {{led}} the group with [[aplomb]].', 'lead'),
    'They _____ the group with aplomb.',
  );
  assert.equal(createClozePrompt('Please lead the way.', 'lead'), 'Please _____ the way.');
});
