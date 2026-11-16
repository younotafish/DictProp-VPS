import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { WordCardHeader } from '../../views/detail/WordCardHeader.tsx';

// The card view's sense of place (UX-18): its header's Got it, or Unarchive with an Archived chip on an archived card.

type HeaderProps = ComponentProps<typeof WordCardHeader>;
const header = (props: Partial<HeaderProps> = {}) => {
  const srs = { ...SRSAlgorithm.createNew('apple-1', 'vocab', 0), totalReviews: 2, memoryStrength: 40 };
  const mastery = SRSAlgorithm.getMasteryLevel(srs);
  return renderToStaticMarkup(createElement(WordCardHeader, {
    showHeader: true, onClose: () => {}, itemCount: 1, itemIndex: 0, onRefresh: () => {}, isSaved: true, onDelete: () => {},
    onSave: () => {}, onRemember: () => {}, onUnarchive: () => {}, moreActionsRef: { current: null }, showActionMenu: false,
    onToggleActionMenu: () => {}, stats: { srs, mastery, colors: getMasteryColors(mastery.color) }, savedItems: [], ...props,
  }));
};
/** The titles of the header's buttons, in order. */
const buttonTitles = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map(match => match[0].match(/title="([^"]*)"/)?.[1] ?? '');

test('a saved card\'s header has a compact Got it between the trash and the More menu', () => {
  const html = header();
  assert.deepEqual(buttonTitles(html), ['', 'Refresh with AI', 'Delete (D)', 'Remember (R)', 'More actions']);
  const gotIt = html.match(/<button[^>]*title="Remember \(R\)"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.match(gotIt, /class="flex h-9 items-center gap-1 rounded-lg bg-emerald-500 px-3 text-sm font-bold text-white transition-colors hover:bg-emerald-600"/);
  assert.match(gotIt, /lucide-check[\s\S]*<\/svg> Got it<\/button>$/);
  assert.doesNotMatch(html, /Archived|Unarchive/);
});

test('an archived card\'s header reads Archived and offers Unarchive in Got it\'s place', () => {
  const html = header({ archived: true });
  assert.deepEqual(buttonTitles(html), ['', 'Refresh with AI', 'Delete (D)', 'Unarchive (A)', 'More actions']);
  assert.doesNotMatch(html, /Got it/);
  assert.match(html, /lucide-archive-restore[\s\S]*?<span class="text-xs font-bold">Unarchive<\/span><\/button>/);
  // The chip leads the second row, before the memory, whose bar takes the width left.
  const secondRow = html.slice(html.indexOf('<div class="px-4 pb-2">'));
  assert.match(secondRow, /^<div class="px-4 pb-2"><div class="flex items-center gap-2 text-xs"><span class="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0\.5 font-semibold text-slate-600"><svg[^>]*lucide-archive[^>]*>[\s\S]*?<\/svg> Archived<\/span>/);
  assert.match(secondRow, /flex-1 h-1\.5 bg-slate-200/);
});

test('an unsaved card offers Save only, and a header told no handler offers no Got it or Unarchive', () => {
  const unsaved = header({ isSaved: false, stats: null });
  assert.deepEqual(buttonTitles(unsaved), ['', 'Refresh with AI', '']);
  assert.match(unsaved, />Save<\/span><\/button>/);
  assert.doesNotMatch(unsaved, /Got it|Archived/);
  assert.doesNotMatch(header({ onRemember: undefined }), /Got it/);
  assert.doesNotMatch(header({ archived: true, onUnarchive: undefined }), /Unarchive/);
  assert.match(header({ archived: true, onUnarchive: undefined }), / Archived<\/span>/, 'the chip still says so');
});
