import assert from 'node:assert/strict';
import test from 'node:test';
import type { BatchImportTally } from '../../services/batchImport.ts';
import { describeBatchResult, describeDuplicateScan, type JobNotice } from '../../services/jobNotices.ts';

// services/jobNotices.ts: what each background job's result pill says, in what tone and for how long.

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

test('no result says it with a check mark or an emoji', () => {
  for (const notice of [
    describeBatchResult({ kind: 'all-saved', listed: 2 }), done({ added: 2 }), done({ failed: 2 }), done({}),
    describeBatchResult({ kind: 'stopped', ...tally() }), describeDuplicateScan(0),
  ]) {
    assertPlain(notice);
  }
});
