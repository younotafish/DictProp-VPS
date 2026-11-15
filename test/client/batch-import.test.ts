import assert from 'node:assert/strict';
import test from 'node:test';
import { runBatchImport, type BatchImportJob, type BatchImportProgress } from '../../services/batchImport.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const vocab = (word: string, sense?: string, id = `${word}-${sense ?? 'main'}`): VocabCard => ({
  id, word, sense, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
});
const saved = (card: VocabCard, deleted = false): StoredItem => ({
  type: 'vocab',
  data: card,
  srs: { id: card.id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  ...(deleted ? { isDeleted: true } : {}),
});

/** A job over `library` whose analysis answers from `senses`, recording what it saved, reported and waited. */
function job(library: StoredItem[], senses: Record<string, VocabCard[] | (() => Promise<VocabCard[]>)>) {
  const savedItems: StoredItem[] = [];
  const reports: BatchImportProgress[] = [];
  const waits: number[] = [];
  const analyzed: string[] = [];
  const config: BatchImportJob = {
    items: () => library,
    analyze: async word => {
      analyzed.push(word);
      const answer = senses[word];
      if (answer === undefined) throw new Error(`no analysis for ${word}`);
      return { vocabs: typeof answer === 'function' ? await answer() : answer };
    },
    save: item => { savedItems.push(item); },
    report: progress => { reports.push(progress); },
    sleep: async ms => { waits.push(ms); },
  };
  return { config, savedItems, reports, waits, analyzed };
}

test('words already saved are skipped, a word listed twice is analyzed once, and nothing new ends the import at once', async () => {
  const library = [saved(vocab('apple')), saved(vocab('pear'), true)];
  const allSaved = job(library, {});
  assert.deepEqual(await runBatchImport(['Apple', ' apple '], allSaved.config), { kind: 'all-saved', listed: 1 });
  assert.deepEqual(allSaved.reports, [], 'no progress for an import with nothing to do');

  const mixed = job(library, { pear: [vocab('pear')], Kiwi: [vocab('kiwi')] });
  const outcome = await runBatchImport(['apple', 'pear', 'Kiwi', 'kiwi'], mixed.config);
  assert.deepEqual(mixed.analyzed.sort(), ['Kiwi', 'pear'], 'a deleted card does not count as saved');
  assert.equal(outcome.kind, 'done');
  if (outcome.kind !== 'done') return;
  assert.equal(outcome.skipped, 1);
  assert.equal(outcome.saved, 2);
  assert.deepEqual(outcome.failedWords, []);
});

test('each new meaning is saved once as a fresh card, even when two words produce it', async () => {
  const run = job([], {
    bank: [vocab('bank', 'river edge', 'ai-1'), vocab('bank', 'money', 'ai-2')],
    banks: [vocab('bank', 'money', 'ai-3')],
  });
  const outcome = await runBatchImport(['banks', 'bank'], run.config);
  assert.equal(outcome.kind, 'done');
  if (outcome.kind !== 'done') return;
  assert.equal(outcome.saved, 2);
  const savedSenses = run.savedItems.map(item => (item.data as VocabCard).sense).sort();
  assert.deepEqual(savedSenses, ['money', 'river edge']);
  for (const item of run.savedItems) {
    assert.equal(item.type, 'vocab');
    assert.equal(item.srs.totalReviews, 0, 'a new schedule');
    assert.equal(item.srs.id, item.data.id);
  }
  assert.deepEqual(outcome.importedIds.sort(), run.savedItems.map(item => item.data.id).sort());
});

test('a meaning the library already holds is not saved again by another listed word', async () => {
  const run = job([saved(vocab('bank', 'river edge'))], {
    banks: [vocab('bank', 'river edge', 'ai-1'), vocab('bank', 'money', 'ai-2')],
  });
  const outcome = await runBatchImport(['banks'], run.config);
  assert.equal(outcome.kind === 'done' && outcome.saved, 1);
  assert.deepEqual(run.savedItems.map(item => (item.data as VocabCard).sense), ['money']);
});

test('a failing word is tried twice, with a longer wait when rate limited, then counted as failed', async () => {
  let attempts = 0;
  const run = job([], {
    flaky: async () => { attempts++; if (attempts === 1) throw new Error('Analysis failed (429)'); return [vocab('flaky')]; },
  });
  const flaky = await runBatchImport(['flaky'], run.config);
  assert.equal(flaky.kind === 'done' && flaky.saved, 1);
  assert.deepEqual(run.waits, [3_000, 2_000, 300], 'rate-limit backoff, the retry delay, then the pause between words');

  const broken = job([], {});
  const outcome = await runBatchImport(['missing'], broken.config);
  assert.equal(outcome.kind, 'done');
  if (outcome.kind !== 'done') return;
  assert.equal(outcome.failed, 1);
  assert.deepEqual(outcome.failedWords, ['missing']);
  assert.deepEqual(broken.analyzed, ['missing', 'missing']);
});

test('progress is reported before the first word and after each one', async () => {
  const run = job([saved(vocab('known'))], { a: [vocab('a')], b: [] });
  await runBatchImport(['known', 'a', 'b'], run.config);
  assert.deepEqual(run.reports[0], { current: 0, total: 2, skipped: 1, failed: 0, saved: 0, isRunning: true });
  assert.equal(run.reports.length, 3);
  assert.deepEqual(run.reports.at(-1), { current: 2, total: 2, skipped: 1, failed: 0, saved: 1, isRunning: true });
});

test('at most five words are analyzed at once', async () => {
  let inFlight = 0;
  let most = 0;
  const words = Array.from({ length: 12 }, (_, index) => `word${index}`);
  const senses = Object.fromEntries(words.map(word => [word, async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight--;
    return [vocab(word)];
  }]));
  const run = job([], senses);
  const outcome = await runBatchImport(words, run.config);
  assert.equal(outcome.kind === 'done' && outcome.saved, 12);
  assert.equal(most, 5);
});
