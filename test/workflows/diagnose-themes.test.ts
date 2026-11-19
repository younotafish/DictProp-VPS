import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { THEMES } from '../../server/src/shared/item-themes.ts';
import { isLoopEligible, isOwnSentence, itemStanding } from '../../services/learningLoop/standing.ts';
import type { StoredItem } from '../../types.ts';
import { passive, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';
import { repoPath } from '../support/paths.ts';
import { block, readWorkflow } from './support/workflow.ts';

// The diagnose workflow's THEMES section counts Today's sentences in SQL, for a log anyone can read. Its counts must be
// the client's: own sentences as isOwnSentence reads them, Today's as isLoopEligible takes them, and each one's standing
// as loopStanding gives it. So its script runs here as the container runs it, on a library saved through the server,
// and its counts are checked against those functions on the same items.

const { env } = await import('../../server/src/env.js');
const { recordThemeResults, upsertItem } = await import('../../server/src/db.js');

const [A, B, C] = THEMES.map(theme => theme.id);
const KNOWN = new Set(THEMES.map(theme => theme.id));
const NOW = 1_800_000_000_000;

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

test("the THEMES section counts Today's sentences as the client does, by standing and theme, in counts and ids only", () => {
  const user = 'diagnose-themes';
  // Each item with the theme its row holds: a scene id, one the taxonomy no longer has, or null for a miss.
  const library: Array<{ item: StoredItem; theme?: string | null }> = [
    ...Array.from({ length: 12 }, (_, n) => ({ item: sentenceItem(`a-${n}`, `Private line a${n}.`), theme: A })),
    // Got it'd in the Sentences tab, and still new to Today.
    { item: sentenceItem('a-got-it', 'Private line, got it.', { srs: reviewed(NOW) }), theme: A },
    ...Array.from({ length: 7 }, (_, n) => ({ item: sentenceItem(`b-${n}`, `Private line b${n}.`), theme: B })),
    { item: sentenceItem('b-practicing', 'Private line, practicing.', { srs: practicing(NOW) }), theme: B },
    ...Array.from({ length: 2 }, (_, n) => ({ item: sentenceItem(`c-${n}`, `Private line c${n}.`), theme: C })),
    { item: sentenceItem('c-sayable', 'Private line, sayable.', { srs: sayable(NOW) }), theme: C },
    { item: sentenceItem('passive', 'Private line, passive.', { srs: passive(NOW) }), theme: 'retired-scene' },
    // Own, but out of Today until a translation comes.
    { item: sentenceItem('untranslated', 'Private line, untranslated.', { translation: null }), theme: B },
    { item: sentenceItem('blank', 'Private line, blank.', { translation: ' \n' }) },
    // Not own: a Real Life record, a catalog line saved to the Sentences tab, an archived sentence, and words.
    { item: sentenceItem('real-life-sentence:cafe:01', 'Private line, catalog.', {
      catalogKind: 'real-life', catalogSentenceId: 'cafe:01', catalogCollectionId: 'cafe',
    }) },
    { item: sentenceItem('saved-line', 'Private line, saved from a catalog.', { catalogSentenceId: 'cafe:02' }) },
    { item: sentenceItem('archived', 'Private line, archived.', { isArchived: true }), theme: A },
    { item: vocabItem('word', 'unplug'), theme: A },
    { item: vocabItem('deleted-word', 'replug', { isDeleted: true }), theme: null },
  ];
  for (const { item, theme } of library) {
    upsertItem(item, user);
    if (theme === undefined) continue;
    recordThemeResults(user, [{ itemId: item.data.id, inputHash: 'h'.repeat(64), themeId: theme }],
      { model: 'test-model', taxonomyVersion: 1, now: NOW });
  }

  const { NODE_OPTIONS: _nodeOptions, ...nodeEnv } = process.env;
  const run = spawnSync(process.execPath, ['-'], { input: themesScript(), encoding: 'utf8', env: nodeEnv });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Private|unplug/, 'no text reaches the public log');
  const report = JSON.parse(run.stdout);

  const eligible = library.filter(({ item }) => isLoopEligible(item));
  const byStanding = { new: 0, practicing: 0, sayable: 0, passive: 0 };
  const newPerScene = new Map<string, number>();
  const perTheme = new Map<string, number>();
  for (const { item, theme } of eligible) {
    byStanding[itemStanding(item)]++;
    if (!theme) continue;
    perTheme.set(theme, (perTheme.get(theme) ?? 0) + 1);
    if (KNOWN.has(theme) && itemStanding(item) === 'new') newPerScene.set(theme, (newPerScene.get(theme) ?? 0) + 1);
  }
  const scenes = [...newPerScene.values()];
  assert.deepEqual({
    ownSentences: report.ownSentences,
    eligibleItems: report.eligibleItems,
    eligibleByStanding: report.eligibleByStanding,
    eligibleWithTheme: report.eligibleWithTheme,
    eligibleWithKnownTheme: report.eligibleWithKnownTheme,
    newSentencesPerScene: report.newSentencesPerScene,
    largestThemes: report.largestThemes,
  }, {
    ownSentences: library.filter(({ item }) => isOwnSentence(item) && !item.isDeleted && !item.isArchived).length,
    eligibleItems: eligible.length,
    eligibleByStanding: byStanding,
    eligibleWithTheme: eligible.filter(({ theme }) => theme).length,
    eligibleWithKnownTheme: eligible.filter(({ theme }) => theme && KNOWN.has(theme)).length,
    newSentencesPerScene: {
      '12+': scenes.filter(count => count >= 12).length,
      '6-11': scenes.filter(count => count >= 6 && count < 12).length,
      '1-5': scenes.filter(count => count < 6).length,
    },
    largestThemes: [...perTheme].sort((a, b) => b[1] - a[1]).map(([theme, sentences]) => ({ theme, sentences })),
  });
  // The library reaches every standing and every bucket, so none of the counts above is vacuous.
  assert.deepEqual(byStanding, { new: 22, practicing: 1, sayable: 1, passive: 1 });
  assert.deepEqual(report.newSentencesPerScene, { '12+': 1, '6-11': 1, '1-5': 1 });
  assert.equal(report.nonSentenceRows, 2);
});
