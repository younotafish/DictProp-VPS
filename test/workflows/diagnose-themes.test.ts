import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { THEMES } from '../../server/src/shared/item-themes.ts';
import { isOwnSentence } from '../../services/learningLoop/standing.ts';
import type { SRSData, StoredItem } from '../../types.ts';
import { sentenceItem, vocabItem } from '../support/loop-fixtures.ts';
import { repoPath } from '../support/paths.ts';
import { block, readWorkflow } from './support/workflow.ts';

// The diagnose workflow's THEMES section counts Today's sentences in SQL, for a log anyone can read. Its counts must be
// the client's: own sentences as isOwnSentence reads them; Today's as isLoopEligible takes them, own, live and with
// text, translated or not; and each one's review state as sentenceReviewState gives it, from its dates alone, whatever
// practice membership an older build left on its schedule. So its script runs here as the container runs it, on a
// library saved through the server, and its counts are checked against those rules on the same items.

const { env } = await import('../../server/src/env.js');
const { db, recordThemeResults, upsertItem } = await import('../../server/src/db.js');
const { reviewStmts } = await import('../../server/src/db/reviews.js');

const [A, B, C] = THEMES.map(theme => theme.id);
const KNOWN = new Set(THEMES.map(theme => theme.id));
const DAY = 86_400_000;
// The script reads its own clock, so the schedules are set around the real one, a day or more either side.
const NOW = Date.now();

/** Reviewed, and memorized for another month. */
const memorized = (srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 2, lastReviewDate: NOW - 3 * DAY, nextReview: NOW + 30 * DAY, fsrsState: 2, ...srs,
});
/** Reviewed, and due again since yesterday. */
const due = (srs: Partial<SRSData> = {}): Partial<SRSData> => ({
  totalReviews: 2, lastReviewDate: NOW - 5 * DAY, nextReview: NOW - DAY, fsrsState: 2, ...srs,
});
// The practice membership the loop before units recorded: practicing, can say it, and kept passive.
const LEFT_AT = NOW - 20 * DAY;
const PRACTICING = { practiceSince: LEFT_AT, practiceChangedAt: LEFT_AT };
const SAYABLE = { sayableAt: LEFT_AT, practiceChangedAt: LEFT_AT };
const PASSIVE = { practiceChangedAt: LEFT_AT };

/** The THEMES section's node script with its container paths moved to this checkout and the test's database. */
function themesScript(): string {
  const lines = block(readWorkflow('diagnose-production.yml'), 'script').split('\n');
  const start = lines.indexOf("echo '=== THEMES ==='");
  const open = lines.findIndex((line, index) => index > start && line.includes("<<'NODE'"));
  const close = lines.findIndex((line, index) => index > open && line === 'NODE');
  assert.ok(start !== -1 && open > start && close > open, 'the THEMES section runs one node script');
  const script = lines.slice(open + 1, close).join('\n')
    .replaceAll('/app/server/node_modules/better-sqlite3', repoPath('server/node_modules/better-sqlite3'))
    // Plain node strips the types of the shared module, which the image ships compiled.
    .replaceAll('/app/server/dist/shared/item-themes.js', repoPath('server/src/shared/item-themes.ts'))
    .replaceAll('/app/data/dictprop.db', resolve(env.DATA_DIR, 'dictprop.db'));
  assert.doesNotMatch(script, /\/app\//);
  return script;
}

let eventCount = 0;
/** A review event as the review route stores it: a unit's Got it on a sentence a day ago unless told otherwise. */
function storeReview(userId: string, itemId: string, fields: Record<string, unknown> = {}): string {
  const row = {
    id: `diagnose-review-${++eventCount}`, user_id: userId, item_id: itemId, item_type: 'sentence', reviewed_at: NOW - DAY,
    previous_step: 0, next_step: 1, rating: 'good', task_type: 'quick', duration_ms: null, session_id: 'set:u1',
    ...fields,
  };
  reviewStmts.insert.run(row);
  return row.id;
}

test("the THEMES section counts Today's sentences as the client does, by review state and theme, in counts and ids only", () => {
  const user = 'diagnose-themes';
  // Each item with the theme its row holds: a scene id, one the taxonomy no longer has, or null for a miss.
  const library: Array<{ item: StoredItem; theme?: string | null }> = [
    // A: twelve to review, one of them only because its dates, not its membership, decide.
    ...Array.from({ length: 11 }, (_, n) => ({ item: sentenceItem(`a-${n}`, `Private line a${n}.`), theme: A })),
    { item: sentenceItem('a-practicing', 'Private line, practicing.', { srs: due(PRACTICING) }), theme: A },
    { item: sentenceItem('a-memorized', 'Private line, memorized.', { srs: memorized() }), theme: A },
    { item: sentenceItem('a-sayable', 'Private line, sayable.', { srs: memorized(SAYABLE) }), theme: A },
    // B: six to review, one of them only because a translation isn't needed.
    ...Array.from({ length: 4 }, (_, n) => ({ item: sentenceItem(`b-${n}`, `Private line b${n}.`), theme: B })),
    { item: sentenceItem('b-due', 'Private line, due.', { srs: due() }), theme: B },
    { item: sentenceItem('b-untranslated', 'Private line, untranslated.', { translation: null }), theme: B },
    { item: sentenceItem('b-passive', 'Private line, passive.', { srs: memorized(PASSIVE) }), theme: B },
    // C: five to review, and one memorized that would make six.
    ...Array.from({ length: 5 }, (_, n) => ({ item: sentenceItem(`c-${n}`, `Private line c${n}.`), theme: C })),
    { item: sentenceItem('c-memorized', 'Private line, memorized too.', { srs: memorized() }), theme: C },
    { item: sentenceItem('retired', 'Private line, retired scene.', { srs: due() }), theme: 'retired-scene' },
    // Today's even with a blank translation, and not sorted yet.
    { item: sentenceItem('blank-translation', 'Private line, blank translation.', { translation: ' \n' }) },
    // Own, but out of Today without text.
    { item: sentenceItem('no-text', ' \n') },
    // Not own: a Real Life record, a catalog line saved to the Sentences tab, an archived sentence, and words, one of
    // them practiced while Today still took words.
    { item: sentenceItem('real-life-sentence:cafe:01', 'Private line, catalog.', {
      catalogKind: 'real-life', catalogSentenceId: 'cafe:01', catalogCollectionId: 'cafe',
    }) },
    { item: sentenceItem('saved-line', 'Private line, saved from a catalog.', { catalogSentenceId: 'cafe:02' }) },
    { item: sentenceItem('archived', 'Private line, archived.', { isArchived: true, srs: due(PRACTICING) }), theme: A },
    { item: vocabItem('word', 'unplug', { srs: due(PRACTICING) }), theme: A },
    { item: vocabItem('deleted-word', 'replug', { isDeleted: true }), theme: null },
  ];
  for (const { item, theme } of library) {
    upsertItem(item, user);
    if (theme === undefined) continue;
    recordThemeResults(user, [{ itemId: item.data.id, inputHash: 'h'.repeat(64), themeId: theme }],
      { model: 'test-model', taxonomyVersion: 1, now: NOW });
  }
  // Got it'd in a unit within the week: a-0 (twice, in two units), a-1 near the week's start, and another user's.
  storeReview(user, 'a-0');
  storeReview(user, 'a-0', { session_id: 'set:u2', reviewed_at: NOW - 2 * DAY });
  storeReview(user, 'a-1', { reviewed_at: NOW - 6 * DAY });
  storeReview('someone-else', 'theirs');
  // Not: too long ago, undone, a set's choice from before units, the Sentences tab's Got it, and a word.
  storeReview(user, 'a-2', { reviewed_at: NOW - 8 * DAY });
  const undone = storeReview(user, 'a-3');
  db.prepare('UPDATE review_events SET undone_at = ? WHERE id = ?').run(NOW - DAY + 60_000, undone);
  storeReview(user, 'a-4', { task_type: 'triage', rating: 'again', session_id: 'set:s1' });
  storeReview(user, 'a-5', { session_id: null });
  storeReview(user, 'word', { item_type: 'vocab' });

  const { NODE_OPTIONS: _nodeOptions, ...nodeEnv } = process.env;
  const run = spawnSync(process.execPath, ['-'], { input: themesScript(), encoding: 'utf8', env: nodeEnv });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Private|unplug/, 'no text reaches the public log');
  const report = JSON.parse(run.stdout);

  const ownLive = (item: StoredItem) => isOwnSentence(item) && !item.isDeleted && !item.isArchived;
  const takenByToday = (item: StoredItem) =>
    isOwnSentence(item) && !item.isDeleted && !item.isArchived && item.data.text.trim() !== '';
  const reviewState = (srs: SRSData | undefined) => ((srs?.totalReviews ?? 0) === 0 ? 'unreviewed'
    : (srs?.nextReview ?? 0) <= NOW ? 'due' : 'memorized');
  const carriesMembership = (srs: SRSData | undefined) =>
    srs?.practiceSince !== undefined || srs?.sayableAt !== undefined || srs?.practiceChangedAt !== undefined;

  const eligible = library.filter(({ item }) => takenByToday(item));
  const byReviewState = { unreviewed: 0, due: 0, memorized: 0 };
  const toReviewPerScene = new Map<string, number>();
  const perTheme = new Map<string, number>();
  for (const { item, theme } of eligible) {
    const state = reviewState(item.srs);
    byReviewState[state]++;
    if (!theme) continue;
    perTheme.set(theme, (perTheme.get(theme) ?? 0) + 1);
    if (KNOWN.has(theme) && state !== 'memorized') toReviewPerScene.set(theme, (toReviewPerScene.get(theme) ?? 0) + 1);
  }
  const scenes = [...toReviewPerScene.values()];
  assert.deepEqual({
    ownSentences: report.ownSentences,
    eligibleItems: report.eligibleItems,
    eligibleByReviewState: report.eligibleByReviewState,
    membershipLeft: report.membershipLeft,
    eligibleWithTheme: report.eligibleWithTheme,
    eligibleWithKnownTheme: report.eligibleWithKnownTheme,
    toReviewPerScene: report.toReviewPerScene,
    largestThemes: report.largestThemes,
  }, {
    ownSentences: library.filter(({ item }) => ownLive(item)).length,
    eligibleItems: eligible.length,
    eligibleByReviewState: byReviewState,
    membershipLeft: library.filter(({ item }) => ownLive(item) && carriesMembership(item.srs)).length,
    eligibleWithTheme: eligible.filter(({ theme }) => theme).length,
    eligibleWithKnownTheme: eligible.filter(({ theme }) => theme && KNOWN.has(theme)).length,
    toReviewPerScene: {
      '12+': scenes.filter(count => count >= 12).length,
      '6-11': scenes.filter(count => count >= 6 && count < 12).length,
      '1-5': scenes.filter(count => count < 6).length,
    },
    largestThemes: [...perTheme].sort((a, b) => b[1] - a[1]).map(([theme, sentences]) => ({ theme, sentences })),
  });
  // The library reaches every review state and every bucket, and each scene sits at a bucket's edge, so a count that
  // let membership hide a due sentence, asked for a translation or took a memorized sentence would move a scene.
  assert.deepEqual(byReviewState, { unreviewed: 22, due: 3, memorized: 4 });
  assert.deepEqual(report.toReviewPerScene, { '12+': 1, '6-11': 1, '1-5': 1 });
  assert.deepEqual(Object.fromEntries(toReviewPerScene), { [A]: 12, [B]: 6, [C]: 5 });
  assert.equal(report.membershipLeft, 3);
  assert.equal(report.unitSentencesLast7Days, 3);
  assert.equal(report.nonSentenceRows, 2);
});
