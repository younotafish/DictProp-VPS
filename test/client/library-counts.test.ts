import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { LibraryCounts } from '../../views/detail/LibraryCounts.tsx';

// The word card header's library-wide counts (views/detail/LibraryCounts.tsx). Each says what it counts, on hover and
// to a screen reader; the clock's label is pinned beside the dashboard's due count in study-stats.test.ts.

const card = (id: string, memoryStrength: number, extra: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, examples: [] } as Partial<VocabCard> as VocabCard,
  savedAt: 0,
  srs: { ...SRSAlgorithm.createNew(id, 'vocab', 0), memoryStrength },
  ...extra,
});

/** The check's attributes and number. */
const check = (items: StoredItem[]) => {
  const markup = renderToStaticMarkup(createElement(LibraryCounts, { savedItems: items }));
  const match = markup.match(/<span class="text-emerald-600 flex items-center gap-0\.5"([^>]*)><svg[^]*?<\/svg>(\d+)<\/span>/);
  assert.ok(match, markup);
  return { attributes: match[1], count: Number(match[2]) };
};

test('the check says it counts the meanings at 70% memory or more, as the clock says what it counts', () => {
  const { attributes, count } = check([
    card('a', 70), card('b', 92), card('c', 69), card('d', 95, { isArchived: true }), card('e', 80, { isDeleted: true }),
  ]);
  assert.equal(count, 2, 'its rule is as before: 70 or more, archived and deleted cards left out');
  assert.equal(attributes, ' role="img" aria-label="2 meanings at 70% memory or more" title="2 meanings at 70% memory or more"');
  assert.match(check([card('a', 75)]).attributes, /aria-label="1 meaning at 70% memory or more"/);
  assert.match(check([]).attributes, /aria-label="0 meanings at 70% memory or more"/);
});
