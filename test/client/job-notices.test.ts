import assert from 'node:assert/strict';
import test from 'node:test';
import type { TtsBackfillStatus } from '../../services/api/tts.ts';
import type { BatchImportTally } from '../../services/batchImport.ts';
import {
  describeBatchResult, describeDuplicateScan, describeSpeechResult, forceSyncText, nextPollDelay, retryingPoll, stuckText,
  syncNoticeState, type JobNotice, type SyncNoticeFacts,
} from '../../services/jobNotices.ts';
import { runSpeechSweep } from '../../services/speechSweep.ts';

// services/jobNotices.ts: what each background job's result pill says, in what tone and for how long, what Sync now
// says, and when the stuck-sync pill shows.

const tally = (counts: Partial<BatchImportTally> = {}): BatchImportTally => ({
  added: 0, saved: 0, skipped: 0, failed: 0, failedWords: [], importedIds: [], ...counts,
});
const done = (counts: Partial<BatchImportTally>) => describeBatchResult({ kind: 'done', ...tally(counts) });

/** No check marks or emoji: the pills say it in words. */
const assertPlain = (notice: JobNotice | null) => {
  if (notice) assert.doesNotMatch(notice.text, /[✓✔]|\p{Extended_Pictographic}/u, notice.text);
};

test('a list already saved says so for three seconds, counting the words', () => {
  assert.deepEqual(describeBatchResult({ kind: 'all-saved', listed: 12 }), { text: 'All 12 words are already saved', tone: 'emerald', timeoutMs: 3_000 });
  assert.equal(describeBatchResult({ kind: 'all-saved', listed: 1 }).text, 'That word is already saved');
  assert.equal(describeBatchResult({ kind: 'all-saved', listed: 1_200 }).text, 'All 1,200 words are already saved');
});

test('a finished import counts the words it added, and those already saved only when there are some, for four seconds', () => {
  assert.deepEqual(done({ added: 18, saved: 31, skipped: 2 }), { text: 'Added 18 words · 2 already saved', tone: 'emerald', timeoutMs: 4_000 });
  assert.equal(done({ added: 1, saved: 3 }).text, 'Added 1 word', 'words, not the cards their meanings made');
  assert.equal(done({ added: 1_204, skipped: 1_000 }).text, 'Added 1,204 words · 1,000 already saved');
  assert.equal(done({ skipped: 3 }).text, 'Nothing new to add · 3 already saved', 'every meaning the analyses found was saved');
  assert.equal(done({}).text, 'Nothing new to add');
});

test('words that failed stay on a rose pill, until dismissed, with the words for Retry', () => {
  const failed = done({ added: 15, failed: 3, failedWords: ['qwxz', 'zzyzx', 'blorp'] });
  assert.deepEqual(failed, { text: 'Couldn’t add 3 words', tone: 'rose', timeoutMs: null, retryWords: ['qwxz', 'zzyzx', 'blorp'] });
  assert.equal(done({ failed: 1, failedWords: ['qwxz'] }).text, 'Couldn’t add 1 word');
});

test('a stopped import says what it added before the stop, on a dark pill for four seconds', () => {
  assert.deepEqual(describeBatchResult({ kind: 'stopped', ...tally({ added: 5, saved: 9 }) }), { text: 'Stopped · added 5 words', tone: 'dark', timeoutMs: 4_000 });
  assert.equal(describeBatchResult({ kind: 'stopped', ...tally({ added: 1, failed: 2, failedWords: ['a', 'b'] }) }).text, 'Stopped · added 1 word');
});

test('a scan for duplicates that finds none says so for three seconds; one that finds some leaves it to the dialog', () => {
  assert.deepEqual(describeDuplicateScan(0), { text: 'No duplicates found', tone: 'emerald', timeoutMs: 3_000 });
  assert.equal(describeDuplicateScan(3), null);
});

const status = (done: number, total: number, running: boolean, generated = 0, failed = 0): TtsBackfillStatus =>
  ({ running, total, done, generated, failed });

test('a finished speech sweep counts the clips it made, and the failures only when there are some, for four seconds', () => {
  assert.deepEqual(
    describeSpeechResult({ kind: 'finished', status: status(7_000, 7_000, false, 120) }, false),
    { text: 'Sentence audio ready · 120 new', tone: 'emerald', timeoutMs: 4_000 },
  );
  assert.equal(describeSpeechResult({ kind: 'finished', status: status(10, 10, false, 1_200, 4) }, false)?.text, 'Sentence audio ready · 1,200 new · 4 failed');
});

test('a sweep that could not start offers Retry for six seconds, unless it was started silently after a batch import', () => {
  assert.deepEqual(describeSpeechResult({ kind: 'start-failed' }, false), {
    text: 'Couldn’t start sentence audio', tone: 'rose', timeoutMs: 6_000, retry: 'speech',
  });
  assert.equal(describeSpeechResult({ kind: 'start-failed' }, true), null);
});

test('a watch that lost the server says the sweep carries on there; a silent start or a hidden watch says nothing', () => {
  assert.deepEqual(describeSpeechResult({ kind: 'poll-failed', status: status(4, 10, true, 2) }, false), {
    text: 'Sentence audio continues on the server', tone: 'dark', timeoutMs: 4_000,
  });
  assert.equal(describeSpeechResult({ kind: 'started', status: status(0, 10, true) }, true), null);
  assert.equal(describeSpeechResult({ kind: 'stopped', status: status(10, 10, false, 10) }, false), null);
});

test('after failed progress checks the watch waits 2, 4, 8 and 16 s before trying again, then gives up', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(nextPollDelay), [2_000, 4_000, 8_000, 16_000, null, null]);
  assert.equal(nextPollDelay(0), null);
});

/** A progress check that answers with `answers` in order, an Error failing that check; `calls` records each try and wait. */
function scriptedPoll(answers: Array<TtsBackfillStatus | Error>, onWait: (ms: number) => void = () => {}) {
  const calls: string[] = [];
  const poll = async () => {
    calls.push('check');
    const answer = answers.shift();
    if (answer === undefined) throw new Error('the test scripted no more checks');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const wait = async (ms: number) => { calls.push(`wait ${ms}`); onWait(ms); };
  return { poll, wait, calls };
}

test('a failed progress check is tried again after each wait, and a check that answers ends the retries', async () => {
  const fine = status(5, 10, true, 3);
  const { poll, wait, calls } = scriptedPoll([new Error('502'), new Error('502'), fine]);
  assert.deepEqual(await retryingPoll(poll, { stopped: () => false, wait })(), fine);
  assert.deepEqual(calls, ['check', 'wait 2000', 'check', 'wait 4000', 'check']);
});

test('the retries give up after about 30 s of failures, with the last failure, and at once when the watch was hidden', async () => {
  const outage = scriptedPoll(Array.from({ length: 6 }, (_, index) => new Error(`down ${index + 1}`)));
  await assert.rejects(retryingPoll(outage.poll, { stopped: () => false, wait: outage.wait })(), /down 5/);
  assert.deepEqual(outage.calls, ['check', 'wait 2000', 'check', 'wait 4000', 'check', 'wait 8000', 'check', 'wait 16000', 'check']);

  let hidden = false;
  const hiddenDuringWait = scriptedPoll([new Error('502'), status(9, 10, true)], () => { hidden = true; });
  await assert.rejects(retryingPoll(hiddenDuringWait.poll, { stopped: () => hidden, wait: hiddenDuringWait.wait })(), /502/);
  assert.deepEqual(hiddenDuringWait.calls, ['check', 'wait 2000'], 'no check after the watch was hidden');
});

test('a watch rides out a short outage until the server says the sweep is done, and a long one ends as continuing there', async () => {
  const run = (answers: Array<TtsBackfillStatus | Error>) => {
    const { poll, wait } = scriptedPoll(answers);
    const stopped = () => false;
    return runSpeechSweep({
      silent: false, onProgress: () => {}, stopped, start: async () => status(0, 10, true), wait,
      poll: retryingPoll(poll, { stopped, wait }),
    });
  };
  const finished = await run([status(4, 10, true), new Error('502'), status(10, 10, false, 10)]);
  assert.equal(describeSpeechResult(finished, false)?.text, 'Sentence audio ready · 10 new', 'a lost check is not the end');

  const lost = await run([status(4, 10, true, 4), ...Array.from({ length: 5 }, () => new Error('502'))]);
  assert.equal(lost.kind, 'poll-failed');
  assert.equal(describeSpeechResult(lost, false)?.text, 'Sentence audio continues on the server');
});

test('no result says it with a check mark or an emoji', () => {
  for (const notice of [
    describeBatchResult({ kind: 'all-saved', listed: 2 }), done({ added: 2 }), done({ failed: 2 }), done({}),
    describeBatchResult({ kind: 'stopped', ...tally() }), describeDuplicateScan(0),
    describeSpeechResult({ kind: 'finished', status: status(3, 3, false, 3, 1) }, false),
    describeSpeechResult({ kind: 'start-failed' }, false), describeSpeechResult({ kind: 'poll-failed', status: status(1, 3, true) }, false),
  ]) {
    assertPlain(notice);
  }
});

test('Sync now says it is syncing, then up to date, or that it could not sync', () => {
  assert.equal(forceSyncText('syncing'), 'Syncing…');
  assert.equal(forceSyncText('done'), 'Up to date');
  assert.equal(forceSyncText('failed'), 'Couldn’t sync');
});

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const stuck = (facts: Partial<SyncNoticeFacts>) => syncNoticeState({
  online: true, visible: true, failures: 2, firstFailureAt: 0, unsent: 3, now: MINUTE, ...facts,
});

test('the stuck pill shows a minute after the first of two or more failed pushes, while changes are unsent', () => {
  assert.deepEqual(stuck({}), { show: true, recheckAt: null });
  assert.deepEqual(stuck({ failures: 7, now: 10 * MINUTE }), { show: true, recheckAt: null });
});

test('before its minute the pill waits, and says when to look again', () => {
  assert.deepEqual(stuck({ firstFailureAt: 5 * SECOND, now: 30 * SECOND }), { show: false, recheckAt: 65 * SECOND });
});

test('one failure, nothing unsent, offline or a hidden page never shows the pill', () => {
  const hidden = { show: false, recheckAt: null };
  assert.deepEqual(stuck({ failures: 1 }), hidden);
  assert.deepEqual(stuck({ unsent: 0 }), hidden);
  assert.deepEqual(stuck({ online: false }), hidden, 'offline is not an error: the Offline chip says it');
  assert.deepEqual(stuck({ visible: false }), hidden);
  assert.deepEqual(stuck({ firstFailureAt: null }), hidden);
  assert.deepEqual(stuck({ failures: 1, now: 0 }), hidden, 'no recheck either until a second failure');
});

test('the stuck pill counts the changes, one or many', () => {
  assert.equal(stuckText(1), '1 change not synced');
  assert.equal(stuckText(3), '3 changes not synced');
  assert.equal(stuckText(1_204), '1,204 changes not synced');
});
