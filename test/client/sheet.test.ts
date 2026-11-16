import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListPlus } from 'lucide-react';
import ts from 'typescript';
import { Sheet, SheetPanel, sheetButton, type SheetButton } from '../../components/Sheet.tsx';
import { BatchImport } from '../../components/BatchImport.tsx';
import { JSONImport } from '../../components/JSONImport.tsx';
import { readRepoFile } from '../support/paths.ts';

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

test('the sheet keeps the full-screen look the tool sheets had, at z-[45]: over the tab bar, beneath the app root\'s z-50 layers', () => {
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

test('an open sheet shows nothing until the app root\'s sheets slot is there to hold it', () => {
  // A server render has no slot (components/noticeSlots' useSheetSlot), as the app has none before its first screen.
  assert.equal(renderToStaticMarkup(createElement(Sheet, { isOpen: true, onClose: noop, title: 'Batch Import', icon: null, children: 'body' })), '');
});

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;
const openingOf = (node: JsxNode) => (ts.isJsxElement(node) ? node.openingElement : node);
/** A JSX element's attributes: a string's text, or an expression's source in braces. */
const jsxAttributes = (node: JsxNode): Map<string, string> => new Map(openingOf(node).attributes.properties.filter(ts.isJsxAttribute)
  .map(attribute => [attribute.name.getText(), attribute.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : attribute.initializer?.getText() ?? 'true']));

test('the sheets slot sits in the app root after the page, taking no room and starting no stacking context of its own', () => {
  // In a portal to <body> a sheet painted over the whole app root, a stacking context of its own (position: fixed), so
  // the search, the notices and any dialog opened over the sheet showed beneath it. In the root, z-[45] orders it among them.
  const app = ts.createSourceFile('App.tsx', readRepoFile('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const roots: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && jsxAttributes(node).get('className') === 'fixed inset-0 bg-white flex flex-col') roots.push(node);
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.equal(roots.length, 1, 'the signed-in app\'s root, with no z-index of its own');
  const children = roots[0].children.filter((child): child is JsxNode => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child));
  const page = children.findIndex(child => openingOf(child).tagName.getText() === 'main');
  const slot = children.findIndex(child => jsxAttributes(child).get('ref') === '{sheetSlotRef}');
  assert.ok(page >= 0 && slot > page, 'after <main>, so outside the page that goes inert');
  assert.equal(openingOf(children[slot]).tagName.getText(), 'div');
  assert.deepEqual(
    [...jsxAttributes(children[slot])],
    [['ref', '{sheetSlotRef}'], ['className', 'contents'], ['inert', '{!!detailContext}']],
    'display: contents, and inert while a card view covers it',
  );
  assert.doesNotMatch(readRepoFile('components/Sheet.tsx'), /document\.body/, 'a sheet portals into the slot, never into <body>');
});

test('a card view opened over a sheet leaves the sheet out of reach, and the sheet takes focus back when the card closes', () => {
  // The search opens a saved sentence's card over Batch import (z-50 over z-[45]). A live slot let Tab into the hidden
  // sheet, whose trap then held focus there, and Space or Enter pressed its hidden Import button. So the slot is inert
  // while a card view is open (the test above), and when the card closes, the sheet takes back the focus it took.
  const app = ts.createSourceFile('App.tsx', readRepoFile('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'useFocusBackWhenUncovered') calls.push(node.arguments.map(arg => arg.getText()));
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.deepEqual(calls, [['!!detailContext', 'readSheetsSlot']], 'covered while the slot is inert');
  assert.match(readRepoFile('App.tsx'), /^const readSheetsSlot = \(\) => readNoticeSlot\('sheets'\);$/m, 'the same function on every render');
});
