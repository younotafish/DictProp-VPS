import assert from 'node:assert/strict';
import test from 'node:test';
import { readRepoFile } from '../support/paths.ts';

// What floats over the word card (views/detail/WordDetailView.tsx) while an example is open over it. The word card's
// playback cluster sits above everything in the card view (z-60 in its z-50 root), and the example opens in that same
// root, so on a Face ID iPhone the example's bottom row (Got it, Save sentence, Delete, Reset) lay under the cluster's
// slideshow, examples and timer buttons, and a tap on Got it started the word slideshow underneath. The view itself
// needs a library to render, so its source is read, as card-float-geometry.test.ts reads the lesson's banner.

test('the word card renders its playback cluster only while no example is open over it', () => {
  const source = readRepoFile('views/detail/WordDetailView.tsx');
  assert.equal(source.match(/<WordPlaybackControls\b/g)?.length, 1, 'the view renders one cluster');
  assert.match(source, /\{!exampleSentencePreview && \(\s*<WordPlaybackControls\b/, 'and only while no example is open');
  // Opening an example stops auto-play, so the cluster has nothing to show while it's gone.
  assert.match(readRepoFile('views/detail/useExampleSentencePreview.ts'), /stopAutoPlay\(\);\s*stopCurrent\(\);\s*setExampleSentencePreview\(/);
});
