import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPlayCountdown } from '../../components/AutoPlayCountdown.tsx';
import { SentencePlaybackControls, autoPlayFabAction } from '../../views/detail/SentencePlaybackControls.tsx';
import { WordPlaybackControls } from '../../views/detail/WordPlaybackControls.tsx';
import { useSentencePlayback } from '../../views/detail/useSentencePlayback.ts';
import type { StoredItem } from '../../types.ts';

// The card view's playback controls (views/detail/SentencePlaybackControls.tsx, WordPlaybackControls.tsx) and the
// Duration countdown (components/AutoPlayCountdown.tsx), rendered to markup, and what sentence review's taps and keys do
// to auto-play (views/detail/useSentencePlayback.ts).

const noop = () => {};
const sentenceControls = (props: Partial<ComponentProps<typeof SentencePlaybackControls>> = {}) =>
  renderToStaticMarkup(createElement(SentencePlaybackControls, {
    onSpeechStyleChange: noop, autoPlaying: true, onAutoPlayButton: noop, showPanel: false, onClosePanel: noop,
    countdownStartedAt: null, timerMinutes: 20, onCycleTimer: noop, repeats: 3, onCycleRepeats: noop, gap: 2000,
    onCycleGap: noop, onStop: noop, ...props,
  }));
/** The auto-play button's opening tag and what it draws. */
const autoPlayButton = (markup: string) => {
  const match = markup.match(/<button[^>]*aria-label="[^"]*auto-play[^"]*"[^>]*>(.*?)<\/button>/);
  assert.ok(match, 'the auto-play button');
  return { tag: match[0].slice(0, match[0].indexOf('>') + 1), icon: match[1] };
};

test('running auto-play\'s button opens its settings; paused, it stays green, shows Play and resumes', () => {
  const running = autoPlayButton(sentenceControls());
  assert.match(running.tag, /aria-label="Open sentence auto-play settings"/);
  assert.match(running.tag, /bg-emerald-500/);
  assert.match(running.icon, /lucide-audio-lines/);

  const paused = autoPlayButton(sentenceControls({ paused: true }));
  assert.match(paused.tag, /aria-label="Resume sentence auto-play"/);
  assert.match(paused.tag, /title="Resume sentence auto-play"/);
  assert.match(paused.tag, /bg-emerald-500/, 'still green: auto-play is on');
  assert.match(paused.icon, /lucide-play/);
  // Same size and place either way (test/client/card-float-geometry.test.ts measures the running one).
  assert.equal(paused.tag.match(/class="([^"]*)"/)?.[1], running.tag.match(/class="([^"]*)"/)?.[1]);

  const stopped = autoPlayButton(sentenceControls({ autoPlaying: false, paused: true }));
  assert.match(stopped.tag, /aria-label="Start sentence auto-play"/, 'stopped auto-play is never paused');
});

test('a tap on the auto-play button starts it, opens or closes its panel while it runs, and resumes it while paused', () => {
  assert.equal(autoPlayFabAction({ autoPlaying: false, paused: false }), 'start');
  assert.equal(autoPlayFabAction({ autoPlaying: false, paused: true }), 'start');
  assert.equal(autoPlayFabAction({ autoPlaying: true, paused: false }), 'toggle-panel');
  assert.equal(autoPlayFabAction({ autoPlaying: true, paused: true }), 'resume');
});

test('a long press on the auto-play button opens its panel, paused or not, and starts auto-play while it\'s off', () => {
  assert.equal(autoPlayFabAction({ autoPlaying: true, paused: false, longPress: true }), 'open-panel');
  assert.equal(autoPlayFabAction({ autoPlaying: true, paused: true, longPress: true }), 'open-panel');
  assert.equal(autoPlayFabAction({ autoPlaying: false, paused: false, longPress: true }), 'start');
});

test('the Clear/Casual switch renders the same with a replay handler', () => {
  const toggle = (markup: string) => markup.match(/<div[^>]*role="group"[^>]*>.*?<\/div>/)?.[0];
  assert.ok(toggle(sentenceControls()));
  assert.equal(toggle(sentenceControls({ onStyleClicked: noop })), toggle(sentenceControls()));
});

test('the panel\'s Duration stands still while auto-play is paused', () => {
  const panel = sentenceControls({ showPanel: true, paused: true, countdownFrozenMs: 125_000 });
  assert.match(panel, /Duration<\/span>2:05<\/button>/);
});

test('word cards\' example auto-play button is a Stop square while it runs', () => {
  const controls = (examplesPlaying: boolean) => renderToStaticMarkup(createElement(WordPlaybackControls, {
    countdownStartedAt: null, timerMinutes: 20, onCycleTimer: noop, slideshowPlaying: false, slideSpeed: 2000,
    onCycleSpeed: noop, onToggleSlideshow: noop, examplesPlaying, repeats: 3, onCycleRepeats: noop, gap: 2000,
    onCycleGap: noop, onToggleExamples: noop,
  }));
  const running = controls(true).match(/<button[^>]*title="Stop auto-play \(Space\)"[^>]*>(.*?)<\/button>/);
  assert.ok(running);
  assert.match(running[1], /lucide-square/);
  assert.doesNotMatch(running[1], /lucide-pause/);
  const idle = controls(false).match(/<button[^>]*title="Auto-play the first two examples of each card \(on a phrase card, the phrase\)"[^>]*>(.*?)<\/button>/);
  assert.ok(idle);
  assert.match(idle[1], /lucide-audio-lines/);
});

test('the countdown shows the preset while stopped, the time left while running, and frozen time while paused', () => {
  const countdown = (props: ComponentProps<typeof AutoPlayCountdown>) => renderToStaticMarkup(createElement(AutoPlayCountdown, props));
  assert.equal(countdown({ deadline: null, frozenRemainingMs: null, minutes: 20 }), '20m');
  assert.equal(countdown({ deadline: null, frozenRemainingMs: 65_000, minutes: 20 }), '1:05');
  assert.equal(countdown({ deadline: null, frozenRemainingMs: 0, minutes: 20 }), '0:00');
  assert.equal(countdown({ deadline: Date.now() + 90_000, frozenRemainingMs: null, minutes: 20 }), '1:30');
  assert.equal(countdown({ deadline: Date.now() - 5_000, frozenRemainingMs: null, minutes: 20 }), '0:00', 'never below zero');
});

test('during auto-play a tap on blank space, E and Space pause or resume auto-play; without it Space starts it', () => {
  const item = { data: { id: 'sentence-1', text: 'A sentence to read.' } } as unknown as StoredItem;
  let autoPlaying = true;
  const calls: string[] = [];
  let playback: ReturnType<typeof useSentencePlayback> | undefined;
  const Probe = () => {
    playback = useSentencePlayback({
      currentSentenceRef: { current: item },
      sentenceItemsRef: { current: [item] },
      currentGroupIndexRef: { current: 0 },
      isSentenceAutoPlayingRef: { get current() { return autoPlaying; } },
      stopAutoPlay: () => calls.push('stop'),
      startAutoPlay: () => calls.push('start'),
      autoPlayRef: { current: { togglePause: () => calls.push('toggle-pause') } },
      setCurrentGroupIndex: noop,
      setCurrentItemIndex: noop,
      onListened: noop,
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  assert.ok(playback);
  playback.toggleSentencePlayback();
  playback.readCurrentSentence();
  playback.handleSpace();
  assert.deepEqual(calls, ['toggle-pause', 'toggle-pause', 'toggle-pause'], 'auto-play keeps running underneath');

  autoPlaying = false;
  calls.length = 0;
  playback.handleSpace();
  assert.deepEqual(calls, ['start'], 'with nothing playing, Space starts auto-play');
});
