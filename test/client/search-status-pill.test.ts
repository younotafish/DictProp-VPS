import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchStatusPill } from '../../components/search/SearchStatusPill.tsx';
import type { SearchStatus } from '../../components/search/searchStatusLine.ts';

const pill = (status: SearchStatus) => renderToStaticMarkup(createElement(SearchStatusPill, { status, onView: () => {} }));
const classesOf = (markup: string) => (/^<div role="status" class="([^"]*)"/.exec(markup)?.[1] ?? '').split(' ');
const buttonsOf = (markup: string) => [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attributes, text]) => ({ attributes, text }));

test('the status line is a polite status in the notice stack\'s dark style, capped beside the search button and truncating', () => {
  const markup = pill({ kind: 'started', text: 'Looking up “gamut”…' });
  assert.match(markup, /^<div role="status" /, 'role="status" announces politely');
  const classes = classesOf(markup);
  for (const name of ['bg-slate-800', 'text-white', 'max-w-[calc(100vw-9rem)]', 'rounded-full', 'pointer-events-auto']) {
    assert.ok(classes.includes(name), name);
  }
  assert.match(markup, /<span class="min-w-0 truncate">Looking up “gamut”…<\/span>/);
  assert.deepEqual(buttonsOf(markup), [], 'nothing to press, and nothing takes focus');
});

test('a ready result carries View, a button, and nothing else does', () => {
  const ready = pill({ kind: 'ready', text: 'gamut +2', viewId: 'q-1' });
  assert.match(ready, /<span class="min-w-0 truncate">gamut \+2<\/span>/);
  const [view, ...rest] = buttonsOf(ready);
  assert.equal(view?.text, 'View');
  assert.match(view?.attributes ?? '', /type="button"/);
  assert.match(view?.attributes ?? '', /title="Open this result"/);
  assert.deepEqual(rest, []);
  for (const status of [{ kind: 'scanning', text: 'Scanning…' }, { kind: 'scan-done', text: 'Found 4 expressions — analyzing…' }] as const) {
    assert.deepEqual(buttonsOf(pill(status)), [], status.kind);
  }
});
