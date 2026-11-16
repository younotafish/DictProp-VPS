import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_GAP_MS, EMPTY_CARD_MS, PAUSE_CAP_MS, createAutoplayController, createSessionClock, initialAutoplayState, reduceAutoplay,
  type AutoplayMode, type AutoplaySettings,
} from '../../services/audio/autoplayController.ts';
import type { InterruptReason, PlaybackStatus } from '../../services/audio/player.ts';

// services/audio/autoplayController.ts: sentence auto-play's reading as a state machine, driven here through a fake
// engine whose reads, gaps and holds the tests end by hand.

interface FakeRead {
  text: string;
  active: boolean;
  stopped: boolean;
  end: () => void;
  fail: () => void;
  interrupt: (reason: InterruptReason) => void;
}

/** A controller over a fake engine that records what it's asked to do. */
function harness(mode: AutoplayMode, settings: AutoplaySettings = { repeats: 1, gapMs: 2000 }) {
  const log: string[] = [];
  const reads: FakeRead[] = [];
  const gaps: Array<{ ms: number; done: () => void; cancelled: boolean }> = [];
  const holds: Array<{ onInterrupted: (reason: InterruptReason) => void; released: boolean }> = [];
  let status: PlaybackStatus = 'idle';
  let cards = 0;
  const controller = createAutoplayController({
    mode,
    speak: (text, callbacks) => {
      // A new read supersedes the one before, as the engine's requests do.
      for (const earlier of reads) earlier.active = false;
      const read: FakeRead = {
        text, active: true, stopped: false,
        end: () => { status = 'idle'; callbacks.onEnd(); },
        fail: () => { status = 'idle'; callbacks.onError(); },
        interrupt: reason => { read.active = false; callbacks.onInterrupted(reason); },
      };
      reads.push(read);
      log.push(`speak ${text}`);
      status = 'loading';
      return { stop: () => { read.stopped = true; read.active = false; }, isActive: () => read.active };
    },
    pauseClip: () => { log.push('pause clip'); status = 'paused'; },
    resumeClip: () => { log.push('resume clip'); status = 'playing'; },
    playbackStatus: () => status,
    afterGap: (ms, done) => {
      const gap = { ms, done, cancelled: false };
      gaps.push(gap);
      log.push(`gap ${ms}`);
      return () => { gap.cancelled = true; };
    },
    reserve: onInterrupted => {
      const hold = { onInterrupted, released: false };
      holds.push(hold);
      return () => { hold.released = true; };
    },
    settings: () => settings,
    finish: () => log.push('finish'),
    roundListened: () => log.push('listened'),
    rearm: () => log.push('rearm'),
  });
  return {
    controller,
    log,
    settings,
    phase: () => controller.getState().phase,
    lastRead: () => reads[reads.length - 1],
    lastGap: () => gaps[gaps.length - 1],
    lastHold: () => holds[holds.length - 1],
    setStatus: (next: PlaybackStatus) => { status = next; },
    /** Start the next card with `texts`; its advance logs which card comes next. */
    card: (...texts: string[]) => {
      const number = ++cards;
      controller.startCard(texts, () => log.push(`advance from card ${number}`));
    },
    /** The read under way plays and ends. */
    play: () => { controller.engineState('playing'); reads[reads.length - 1].end(); },
    /** The gap under way runs out. */
    endGap: () => gaps[gaps.length - 1].done(),
  };
}

test('word cards: each example as many times as asked with the gap between reads, then a short beat before the next card', () => {
  const h = harness('word-cards', { repeats: 2, gapMs: 3000 });
  h.card('One.', 'Two.');
  h.play(); h.endGap();
  h.play(); h.endGap();
  h.play(); h.endGap();
  h.play(); h.endGap();
  assert.deepEqual(h.log, [
    'speak One.', 'gap 3000', 'speak One.', 'gap 3000', 'speak Two.', 'gap 3000', 'speak Two.', `gap ${CARD_GAP_MS}`,
    'advance from card 1',
  ]);
  assert.equal(h.phase(), 'idle', 'waiting for the next card');
});

test('sentence review: the gap between cards too, and a round heard in full is a listen', () => {
  const h = harness('sentence-review', { repeats: 2, gapMs: 2000 });
  h.card('A sentence.');
  h.play(); h.endGap();
  h.play();
  assert.deepEqual(h.log, ['speak A sentence.', 'gap 2000', 'speak A sentence.', 'listened', 'gap 2000']);
  h.endGap();
  assert.equal(h.log.at(-1), 'advance from card 1');

  // A read that fails still moves on, but the round isn't a listen.
  const failing = harness('sentence-review', { repeats: 2, gapMs: 2000 });
  failing.card('A sentence.');
  failing.lastRead().fail(); failing.endGap();
  failing.play();
  assert.ok(!failing.log.includes('listened'));
});

test('repeats and the gap are read as the reading goes', () => {
  const h = harness('sentence-review', { repeats: 1, gapMs: 2000 });
  h.card('A sentence.');
  h.settings.repeats = 2;
  h.settings.gapMs = 5000;
  h.play();
  assert.deepEqual(h.log, ['speak A sentence.', 'gap 5000']);
  h.endGap();
  assert.equal(h.log.at(-1), 'speak A sentence.', 'read again, now that it is read twice');
});

test('a pause mid-read pauses the clip and a resume plays it on; one while the clip loads holds it the same way', () => {
  for (const playing of [true, false]) {
    const h = harness('sentence-review');
    h.card('A sentence.');
    if (playing) h.controller.engineState('playing');
    h.controller.pause();
    assert.equal(h.phase(), 'paused');
    assert.equal(h.log.at(-1), 'pause clip');
    h.controller.engineState('paused');
    assert.equal(h.phase(), 'paused', 'its own pause, no surprise');
    h.controller.resume();
    assert.deepEqual(h.log.slice(-2), ['rearm', 'resume clip']);
    assert.equal(h.phase(), playing ? 'reading' : 'loading');
    assert.equal(h.log.filter(line => line.startsWith('speak')).length, 1, 'the same read, not a new one');
  }
});

test('a resume after the engine let go of the paused clip reads the text again, the repeat count kept', () => {
  const h = harness('sentence-review', { repeats: 3, gapMs: 2000 });
  h.card('A sentence.');
  h.play(); h.endGap();
  h.controller.engineState('playing');
  h.controller.pause();
  h.setStatus('idle');
  h.controller.resume();
  assert.equal(h.log.at(-1), 'speak A sentence.');
  assert.equal(h.controller.getState().repeat, 1, 'still the second read');
});

test('a pause in a gap cancels it and lets go of the engine; the resume takes the next step at once', () => {
  const h = harness('sentence-review', { repeats: 2, gapMs: 2000 });
  h.card('A sentence.');
  h.play();
  const gap = h.lastGap();
  const hold = h.lastHold();
  h.controller.togglePause();
  assert.equal(h.phase(), 'paused');
  assert.equal(gap.cancelled, true);
  assert.equal(hold.released, true);
  h.controller.togglePause();
  assert.deepEqual(h.log.slice(-2), ['rearm', 'speak A sentence.']);
  assert.equal(h.controller.getState().repeat, 1);
});

test('something else speaking mid-read pauses sentence review; the resume reads the sentence again, uncounted', () => {
  const h = harness('sentence-review', { repeats: 2, gapMs: 2000 });
  h.card('A sentence.');
  h.controller.engineState('playing');
  h.lastRead().interrupt('superseded');
  assert.equal(h.phase(), 'paused');
  assert.equal(h.controller.getState().resume, 'read');
  h.controller.resume();
  assert.deepEqual(h.log.slice(-2), ['rearm', 'speak A sentence.']);
  assert.equal(h.controller.getState().repeat, 0, 'the cut-off read is not a repeat');
  h.play(); h.endGap(); h.play();
  assert.ok(h.log.includes('listened'), 'two full reads after the resume make the round');
});

test('something else speaking in a gap pauses it too, and the resume takes the step', () => {
  const h = harness('sentence-review');
  h.card('A sentence.');
  h.play();
  const gap = h.lastGap();
  h.lastHold().onInterrupted('superseded');
  assert.equal(h.phase(), 'paused');
  assert.equal(gap.cancelled, true, 'the next read won\'t talk over the other speech');
  h.controller.resume();
  assert.equal(h.log.at(-1), 'advance from card 1');
});

test('on word cards anything else speaking ends auto-play, mid-read or in a gap', () => {
  const reading = harness('word-cards');
  reading.card('One.');
  reading.lastRead().interrupt('stopped');
  assert.equal(reading.log.at(-1), 'finish');
  assert.equal(reading.phase(), 'ended');

  const waiting = harness('word-cards');
  waiting.card('One.', 'Two.');
  waiting.play();
  waiting.lastHold().onInterrupted('superseded');
  assert.equal(waiting.log.at(-1), 'finish');
  assert.equal(waiting.lastGap().cancelled, true);
});

test('a callback from an earlier read or gap is ignored', () => {
  const h = harness('sentence-review', { repeats: 2, gapMs: 2000 });
  h.card('A sentence.');
  const first = h.lastRead();
  h.controller.restartRead();
  const before = h.log.length;
  first.end();
  first.interrupt('superseded');
  assert.equal(h.log.length, before);
  assert.equal(h.phase(), 'loading');
  // The read under way is still the one paused and resumed.
  h.controller.engineState('playing');
  h.controller.pause();
  h.controller.resume();
  assert.deepEqual(h.log.slice(before), ['pause clip', 'rearm', 'resume clip']);
});

test('a new voice reads the sentence again from its start, the repeat count kept; a paused clip is read again on resume', () => {
  const h = harness('sentence-review', { repeats: 3, gapMs: 2000 });
  h.card('A sentence.');
  h.play(); h.endGap();
  h.controller.engineState('playing');
  const second = h.lastRead();
  h.controller.restartRead();
  assert.equal(second.stopped, true, 'the owner\'s stop, which is no interruption');
  assert.equal(h.log.at(-1), 'speak A sentence.');
  assert.equal(h.controller.getState().repeat, 1);

  h.controller.engineState('playing');
  h.controller.pause();
  h.controller.restartRead();
  assert.equal(h.phase(), 'paused', 'a paused reading stays paused');
  h.controller.resume();
  assert.equal(h.log.at(-1), 'speak A sentence.', 'read again in the new voice');
});

test('a new voice in a gap holds the engine again, so the style change itself is no interruption', () => {
  const h = harness('sentence-review');
  h.card('A sentence.');
  h.play();
  const first = h.lastHold();
  h.controller.restartRead();
  assert.equal(first.released, true);
  assert.notEqual(h.lastHold(), first);
  assert.equal(h.phase(), 'gap');
  h.endGap();
  assert.equal(h.log.at(-1), 'advance from card 1');
});

test('the timer running out mid-read lets that read finish, then ends auto-play; in a gap it ends at once', () => {
  const h = harness('sentence-review');
  h.card('A sentence.');
  h.controller.engineState('playing');
  h.controller.timerEnded();
  assert.equal(h.phase(), 'reading');
  h.lastRead().end();
  assert.deepEqual(h.log.slice(-2), ['listened', 'finish'], 'the finished read still counts');

  const gap = harness('sentence-review');
  gap.card('A sentence.');
  gap.play();
  gap.controller.timerEnded();
  assert.equal(gap.log.at(-1), 'finish');
  assert.equal(gap.lastGap().cancelled, true);
});

test('pauses it didn\'t ask for (the OS, a headset) pause the reading, and the clip playing again resumes it', () => {
  const h = harness('word-cards');
  h.card('One.');
  h.controller.engineState('playing');
  h.controller.engineState('paused');
  assert.equal(h.phase(), 'paused');
  assert.equal(h.controller.getState().resume, 'clip');
  h.controller.engineState('playing');
  assert.equal(h.phase(), 'reading');
  assert.equal(h.log.at(-1), 'rearm');
});

test('a new card always plays, though the one before was paused; an empty card moves on after a moment', () => {
  const h = harness('sentence-review');
  h.card('One.');
  h.controller.pause();
  h.controller.cancelCard();
  h.card();
  assert.equal(h.phase(), 'gap');
  assert.equal(h.lastGap().ms, EMPTY_CARD_MS);
  h.endGap();
  assert.equal(h.log.at(-1), 'advance from card 2');
  h.card('Three.');
  assert.equal(h.phase(), 'loading');
});

test('a read that can\'t start counts as failed, so the reading moves on', async () => {
  const log: string[] = [];
  const controller = createAutoplayController({
    mode: 'word-cards',
    speak: (text) => { log.push(`speak ${JSON.stringify(text)}`); return { stop: () => {}, isActive: () => false }; },
    pauseClip: () => {}, resumeClip: () => {}, playbackStatus: () => 'idle',
    afterGap: (ms) => { log.push(`gap ${ms}`); return () => {}; },
    settings: () => ({ repeats: 1, gapMs: 2000 }),
    finish: () => {},
  });
  controller.startCard(['  ', 'Two.'], () => {});
  await Promise.resolve();
  assert.deepEqual(log, ['speak "  "', 'gap 2000']);
});

test('stopping ends it for good: the read and the gap stop, and later callbacks do nothing', () => {
  const h = harness('sentence-review');
  h.card('One.');
  const read = h.lastRead();
  h.controller.stop();
  assert.equal(read.stopped, true);
  assert.equal(h.phase(), 'ended');
  read.end();
  h.controller.resume();
  h.card('Two.');
  assert.ok(!h.log.includes('speak Two.'));

  const waiting = harness('sentence-review');
  waiting.card('One.');
  waiting.play();
  waiting.controller.stop();
  assert.equal(waiting.lastGap().cancelled, true);
  assert.equal(waiting.lastHold().released, true);
});

test('the reducer leaves its state alone and answers a stale command with nothing', () => {
  const start = reduceAutoplay(initialAutoplayState('sentence-review'), { type: 'startCard', texts: ['A.'] });
  const frozen = JSON.stringify(start.state);
  const stale = reduceAutoplay(start.state, { type: 'readEnded', turn: start.state.turn - 1, ok: true, settings: { repeats: 1, gapMs: 1 } });
  assert.equal(stale.state, start.state);
  assert.deepEqual(stale.effects, []);
  reduceAutoplay(start.state, { type: 'pause' });
  assert.equal(JSON.stringify(start.state), frozen);
  assert.deepEqual(start.effects, [{ type: 'stopRead' }, { type: 'cancelWait' }, { type: 'speak', text: 'A.', turn: 1 }]);
});

test('the session clock stands still while paused', () => {
  let now = 1_000;
  const clock = createSessionClock(() => now);
  const minutes = (count: number) => count * 60_000;
  assert.equal(clock.deadline(minutes(20)), null, 'not started');
  clock.start();
  assert.equal(clock.deadline(minutes(20)), 1_000 + minutes(20));
  now += minutes(5);
  clock.pause();
  assert.equal(clock.deadline(minutes(20)), null);
  now += minutes(3);
  assert.equal(clock.remainingMs(minutes(20)), minutes(15), 'frozen');
  assert.equal(clock.isPaused(), true);
  clock.resume();
  assert.equal(clock.deadline(minutes(20)), 1_000 + minutes(23), 'the pause pushes the end back');
  now += minutes(16);
  assert.equal(clock.remainingMs(minutes(20)), 0);
  assert.equal(clock.elapsedMs(), minutes(21));
});

test('a pause that lasts 15 minutes ends the session, though the Duration stands still through it', () => {
  let now = 0;
  const minutes = (count: number) => count * 60_000;
  const duration = minutes(20);
  assert.equal(PAUSE_CAP_MS, minutes(15));
  const clock = createSessionClock(() => now);
  clock.start();
  now += minutes(5);
  assert.equal(clock.isOver(duration), false);
  clock.pause();
  now += PAUSE_CAP_MS - 1;
  assert.equal(clock.isOver(duration), false, 'paused just short of the cap');
  assert.equal(clock.remainingMs(duration), minutes(15), 'the Duration stood still');
  now += 1;
  assert.equal(clock.isOver(duration), true, 'the pause reached the cap');

  // Each pause counts afresh, and running, the Duration ends the session as before, the pauses not counted.
  const resumed = createSessionClock(() => now);
  resumed.start();
  for (let pause = 0; pause < 2; pause++) {
    resumed.pause();
    now += minutes(14);
    assert.equal(resumed.isOver(duration), false, 'a pause under the cap');
    resumed.resume();
  }
  now += duration - 1;
  assert.equal(resumed.isOver(duration), false);
  now += 1;
  assert.equal(resumed.isOver(duration), true, 'the Duration ran out');
});
