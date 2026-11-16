import assert from 'node:assert/strict';
import test from 'node:test';
import type { TtsBackfillStatus } from '../../services/api/tts.ts';
import { runSpeechSweep, type SpeechSweepRun } from '../../services/speechSweep.ts';

// services/speechSweep.ts, the server-side speech sweep the notebook's "Generate speech cache" starts and batch
// import starts silently: what the progress pill hears, how a watch ends, and the dialog each ending shows.

const status = (done: number, total: number, running: boolean, generated = 0, failed = 0): TtsBackfillStatus =>
  ({ running, total, done, generated, failed });

/**
 * A run whose server answers the start with `started` (or fails it) and the progress checks with `checks`, in
 * order (an Error fails that check). `calls` records the progress reports, the stop checks, the waits and the
 * server calls in the order they happen; `onWait` runs inside each wait, where a test presses Stop.
 */
function scripted(
  started: TtsBackfillStatus | Error,
  checks: Array<TtsBackfillStatus | Error> = [],
  { silent = false, onWait = () => {} }: { silent?: boolean; onWait?: () => void } = {},
) {
  const calls: string[] = [];
  const stop = { pressed: false };
  const run: SpeechSweepRun = {
    silent,
    onProgress: progress => {
      calls.push(progress ? `progress ${progress.current}/${progress.total}${progress.isRunning ? '' : ' done'}` : 'progress cleared');
    },
    stopped: () => {
      calls.push('stopped?');
      return stop.pressed;
    },
    start: async () => {
      calls.push('start');
      if (started instanceof Error) throw started;
      return started;
    },
    poll: async () => {
      calls.push('check');
      const answer = checks.shift();
      if (answer === undefined) throw new Error('the test scripted no more checks');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    wait: async ms => {
      calls.push(`wait ${ms}`);
      onWait();
    },
  };
  return { run, calls, stop };
}

test('a start that fails reports start-failed, silent or not, and nothing is watched', async () => {
  for (const silent of [false, true]) {
    const { run, calls } = scripted(new TypeError('Failed to fetch'), [], { silent });
    const outcome = await runSpeechSweep(run);
    assert.deepEqual(outcome, { kind: 'start-failed' });
    assert.deepEqual(calls, ['start'], 'no progress, no stop check, no wait, no check');
  }
});

test('a silent run only starts the sweep: no progress pill and no checks', async () => {
  const started = status(3, 40, true);
  const { run, calls } = scripted(started, [], { silent: true });
  const outcome = await runSpeechSweep(run);
  assert.deepEqual(outcome, { kind: 'started', status: started });
  assert.deepEqual(calls, ['start']);
});

test('a watched sweep shows the start’s snapshot and checks every 3 s until the server is done', async () => {
  const done = status(10, 10, false, 6, 1);
  const { run, calls } = scripted(status(2, 10, true), [status(5, 10, true, 3), done]);
  const outcome = await runSpeechSweep(run);
  assert.deepEqual(calls, [
    'start',
    // The first report comes before the first stop check, so the hook can start the watch with Stop unpressed.
    'progress 2/10', 'stopped?', 'wait 3000', 'check',
    'progress 5/10', 'stopped?', 'wait 3000', 'check',
    'progress 10/10 done', 'progress cleared', 'stopped?',
  ]);
  assert.deepEqual(outcome, { kind: 'finished', status: done });
});

test('Stop ends the watch, even when the check under way finds the sweep done', async () => {
  const done = status(10, 10, false, 10);
  const pressedDuringWait = scripted(status(0, 10, true), [done], { onWait: () => { pressedDuringWait.stop.pressed = true; } });
  const outcome = await runSpeechSweep(pressedDuringWait.run);
  assert.deepEqual(pressedDuringWait.calls, ['start', 'progress 0/10', 'stopped?', 'wait 3000', 'check', 'progress 10/10 done', 'progress cleared', 'stopped?']);
  assert.deepEqual(outcome, { kind: 'stopped', status: done });

  // Pressed while the server is still going: the watch ends before another wait or check.
  const stillRunning = status(4, 10, true, 4);
  const pressedLater = scripted(status(0, 10, true), [stillRunning, status(8, 10, true)], {
    onWait: () => { pressedLater.stop.pressed = true; },
  });
  assert.deepEqual(await runSpeechSweep(pressedLater.run), { kind: 'stopped', status: stillRunning });
  assert.deepEqual(pressedLater.calls, ['start', 'progress 0/10', 'stopped?', 'wait 3000', 'check', 'progress 4/10', 'stopped?', 'progress cleared', 'stopped?']);
});

test('a failed check ends the watch and reports the last snapshot', async () => {
  const last = status(4, 10, true, 2, 1);
  const { run, calls } = scripted(status(1, 10, true), [last, new Error('Load TTS backfill status failed (502)')]);
  const outcome = await runSpeechSweep(run);
  assert.deepEqual(calls, ['start', 'progress 1/10', 'stopped?', 'wait 3000', 'check', 'progress 4/10', 'stopped?', 'wait 3000', 'check', 'progress cleared', 'stopped?']);
  assert.deepEqual(outcome, { kind: 'poll-failed', status: last });
});

test('by default the sweep starts through the speech server’s backfill route', async () => {
  const realFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    return Response.json(status(0, 25, true));
  }) as typeof fetch;
  try {
    const outcome = await runSpeechSweep({ silent: true, onProgress: () => assert.fail('a silent run reports nothing'), stopped: () => false });
    assert.deepEqual(outcome, { kind: 'started', status: status(0, 25, true) });
    assert.deepEqual(requests, ['POST /api/tts/backfill']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
