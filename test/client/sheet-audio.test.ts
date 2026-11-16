import assert from 'node:assert/strict';
import test from 'node:test';
import { BETWEEN_EXAMPLES_MS, createSheetAudio } from '../../components/search/sheetAudio.ts';
import type { SpeakHandle, SpeakOptions } from '../../services/neuralTts.ts';

/**
 * An engine with one voice, like services/neuralTts: each speak supersedes the one before, and a handle stops only
 * the playback it started, while nothing has superseded it. The test ends a clip with end(), and runs the pauses
 * between examples itself.
 */
function engine() {
  let owner = 0;
  const log: string[] = [];
  const endings = new Map<string, () => void>();
  const speak = (label: string, options?: SpeakOptions): SpeakHandle => {
    const mine = ++owner;
    log.push(`play ${label}`);
    endings.set(label, () => { if (mine === owner) options?.onEnd?.(); });
    return {
      stop: () => {
        if (mine !== owner) return;
        owner++;
        log.push(`stop ${label}`);
      },
      isActive: () => mine === owner,
    };
  };
  const pauses: Array<{ next: () => void; ms: number }> = [];
  return {
    log,
    pauses,
    audio: createSheetAudio(
      { speakWord: text => speak(`word:${text}`), speakNatural: (text, options) => speak(`sentence:${text}`, options) },
      (next, ms) => { pauses.push({ next, ms }); },
    ),
    /** Something else in the app speaks over the sheet. */
    foreign: (label: string) => speak(`foreign:${label}`),
    end: (label: string) => endings.get(label)?.(),
  };
}

test('stopping stops the last thing the sheet said or read, once', () => {
  const { audio, log } = engine();
  audio.word('gamut');
  audio.sentence('It ran the gamut.');
  audio.stop();
  audio.stop();
  assert.deepEqual(log, ['play word:gamut', 'play sentence:It ran the gamut.', 'stop sentence:It ran the gamut.']);
});

test('a handle a newer sheet speak superseded is never stopped again', () => {
  const { audio, log } = engine();
  audio.sentence('One.');
  audio.word('two');
  audio.stop();
  assert.deepEqual(log.filter(line => line.startsWith('stop')), ['stop word:two']);
});

test('audio the sheet did not start is never stopped', () => {
  const { audio, log, foreign } = engine();
  audio.word('gamut');
  foreign('sentence review');
  audio.stop();
  assert.deepEqual(log, ['play word:gamut', 'play foreign:sentence review']);
  const fresh = engine();
  fresh.foreign('auto-play');
  fresh.audio.stop();
  assert.deepEqual(fresh.log, ['play foreign:auto-play'], 'nor when the sheet has said nothing');
});

test('examples read in turn follow each other after a pause, and stop as one', () => {
  const { audio, log, pauses, end } = engine();
  audio.inTurn(['First.', 'Second.', 'Third.']);
  end('sentence:First.');
  assert.deepEqual(pauses.map(pause => pause.ms), [BETWEEN_EXAMPLES_MS]);
  pauses.shift()?.next();
  assert.deepEqual(log, ['play sentence:First.', 'play sentence:Second.']);
  audio.stop();
  end('sentence:Second.');
  for (const pause of pauses.splice(0)) pause.next();
  assert.deepEqual(log, ['play sentence:First.', 'play sentence:Second.', 'stop sentence:Second.'], 'the third never starts');
});

test('a run read in turn ends when anything else speaks, the sheet or not', () => {
  const sheet = engine();
  sheet.audio.inTurn(['First.', 'Second.']);
  sheet.end('sentence:First.');
  sheet.audio.word('gamut'); // the user moved to another meaning during the pause
  sheet.pauses.shift()?.next();
  assert.deepEqual(sheet.log, ['play sentence:First.', 'play word:gamut']);

  const other = engine();
  other.audio.inTurn(['First.', 'Second.']);
  other.end('sentence:First.');
  other.foreign('auto-play');
  other.pauses.shift()?.next();
  assert.deepEqual(other.log, ['play sentence:First.', 'play foreign:auto-play'], 'nothing talks over audio that took over');
});
