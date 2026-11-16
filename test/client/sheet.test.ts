import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListPlus } from 'lucide-react';
import { Sheet, SheetPanel, sheetButton, type SheetButton } from '../../components/Sheet.tsx';
import { BatchImport } from '../../components/BatchImport.tsx';
import { JSONImport } from '../../components/JSONImport.tsx';

const noop = () => {};
const close: SheetButton = { kind: 'close', label: 'Close', onClick: noop };

// The server renderer can't render Sheet's portal, so the panel it portals is rendered alone.
const panel = (button: SheetButton | null, subtitle?: string) => renderToStaticMarkup(createElement(SheetPanel, {
  titleId: 'batch-title', title: 'Batch Import', icon: createElement(ListPlus, { size: 20, className: 'text-indigo-600' }),
  subtitle: subtitle && createElement('p', { className: 'text-xs text-slate-400 mt-0.5' }, subtitle),
  button, children: createElement('div', { className: 'flex-1 overflow-y-auto px-4 pt-4 pb-8' }, 'The sheet’s body'),
}));

/** The attributes of the first element `pattern` matches in `markup`. */
const attributesOf = (markup: string, pattern: RegExp): string => pattern.exec(markup)?.[1] ?? '';

test('a sheet is a modal dialog named by its title, which can take focus', () => {
  const markup = panel(close);
  const root = attributesOf(markup, /^<div([^>]*)>/);
  assert.match(root, /role="dialog"/);
  assert.match(root, /aria-modal="true"/);
  assert.match(root, /tabindex="-1"/);
  assert.match(root, /aria-labelledby="batch-title"/);
  assert.match(markup, /<h2 id="batch-title" class="[^"]*"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Batch Import<\/h2>/, 'the icon stays out of the name');
});

test('the sheet keeps the full-screen look the tool sheets had, at z-[45] beneath the app\'s z-50 layers', () => {
  const markup = panel(close);
  assert.equal(
    attributesOf(markup, /^<div[^>]* class="([^"]*)"/),
    'fixed inset-0 z-[45] bg-white flex flex-col outline-none',
  );
  assert.match(markup, /<div class="shrink-0 px-4 py-3 border-b border-slate-200 bg-white flex items-center gap-3">/, 'the header');
  assert.match(markup, /<\/div><\/div><div class="flex-1 overflow-y-auto px-4 pt-4 pb-8">The sheet’s body<\/div><\/div>$/, 'the body after it');
});

test('its header button is Close, an X labelled for screen readers', () => {
  const markup = panel(close);
  const button = /<button([^>]*)>(.*?)<\/button>/.exec(markup);
  assert.ok(button, 'one button in the header');
  assert.match(button[1], /aria-label="Close"/);
  assert.match(button[1], /class="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"/);
  assert.match(button[2], /lucide-x/);
});

test('a sheet can step back with a chevron, show no button, and say what it is doing under its title', () => {
  const back = panel({ kind: 'back', label: 'Back to the text', onClick: noop });
  assert.match(back, /<button aria-label="Back to the text"[^>]*><svg[^>]*lucide-chevron-left/);
  assert.doesNotMatch(back, /lucide-x/);
  assert.doesNotMatch(panel(null), /<button/);
  assert.match(panel(null, 'Analyzing 2/5...'), /Batch Import<\/h2><p class="text-xs text-slate-400 mt-0\.5">Analyzing 2\/5\.\.\.<\/p><\/div>/);
});

test('left to itself the header button is Close, calling onClose; a sheet may name its own, or have none', () => {
  let closed = 0;
  const button = sheetButton(undefined, () => { closed++; });
  assert.deepEqual([button?.kind, button?.label], ['close', 'Close']);
  button?.onClick();
  assert.equal(closed, 1);
  const own: SheetButton = { kind: 'back', label: 'Back to the text', onClick: noop };
  assert.equal(sheetButton(own, noop), own);
  assert.equal(sheetButton(null, noop), null);
});

test('a closed sheet renders nothing, and so do the closed import sheets', () => {
  assert.equal(renderToStaticMarkup(createElement(Sheet, { isOpen: false, onClose: noop, title: 'Batch Import', icon: null, children: 'body' })), '');
  assert.equal(renderToStaticMarkup(createElement(BatchImport, { isOpen: false, onClose: noop, onSubmit: noop })), '');
  assert.equal(renderToStaticMarkup(createElement(JSONImport, { isOpen: false, onClose: noop, onImported: noop })), '');
});
