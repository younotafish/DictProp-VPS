import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoticePill } from '../../components/NoticePill.tsx';
import { RefusedChangesNotice, RefusedChangesPill, useDismissedUntilNew } from '../../components/RefusedChanges.tsx';
import type { StoredItem } from '../../types.ts';

// components/RefusedChanges.tsx: the notice about changes the server refused, which stay on this device. Its words and
// its × are rendered on the server; the dismissal, which needs state, runs in a component that draws nothing.

/** An item the server refused, of `type`, titled `title` as the server may have found it: missing, or not text. */
const refusedItem = (title: unknown, type: StoredItem['type'] = 'vocab'): StoredItem => {
  const field = { vocab: 'word', phrase: 'query', sentence: 'text' }[type];
  return { type, data: { id: `refused-${String(title)}`, [field]: title }, savedAt: 1 } as unknown as StoredItem;
};

/** The notice for `items` as it first shows: its attributes, its text, and what follows the text. */
const notice = (items: StoredItem[]) => {
  const html = renderToStaticMarkup(createElement(RefusedChangesNotice, { items }));
  const pill = html.match(/^<div role="status"([^>]*)><span class="min-w-0 line-clamp-3">([^<]*)<\/span>(.*)<\/div>$/);
  assert.ok(pill, html);
  return { attributes: pill[1], text: pill[2], after: pill[3] };
};

test('the notice names one refused item and counts several, on an amber pill of up to three lines with a × and no View', () => {
  const one = notice([refusedItem('gamut')]);
  assert.match(one.attributes, /^ class="[^"]*rounded-2xl bg-amber-600[^"]*"$/, 'no tooltip: the whole title shows');
  assert.equal(one.text, '“gamut” stays on this device: the server refused it');
  assert.match(one.after, /^<button type="button" title="Dismiss" aria-label="Dismiss the refused changes notice" class="shrink-0 w-8 h-8 rounded-full[^"]*"><svg[^>]*lucide-x[^>]*>.*<\/svg><\/button>$/);
  const several = notice(['gamut', 'atlas', 'ebb'].map(word => refusedItem(word)));
  assert.equal(several.text, '3 changes stay on this device: the server refused them');
  assert.match(several.after, /^<button type="button" title="Dismiss" aria-label="Dismiss the refused changes notice"/);
});

test('one item is named as the undo pill names it, and a long title is cut short so the rest of the notice still shows', () => {
  assert.equal(notice([refusedItem('{{Run}} for the [[hills]]!', 'sentence')]).text, '“Run for the hills!” stays on this device: the server refused it');
  assert.equal(notice([refusedItem('take   something\nfor granted', 'phrase')]).text, '“take something for…” stays on this device: the server refused it');
  // Cut after the last word that fits, with the whole of it as the pill's tooltip and accessible name.
  const sentence = notice([refusedItem('She {{ran}} all the way to the [[station]] in the rain.', 'sentence')]);
  assert.equal(sentence.text, '“She ran all the way…” stays on this device: the server refused it');
  const whole = '“She ran all the way to the station in the rain.” stays on this device: the server refused it';
  assert.equal(sentence.attributes.match(/^ title="([^"]*)" aria-label="([^"]*)"/)?.slice(1).join('|'), `${whole}|${whole}`);
  // A word longer than the limit is cut at the limit.
  assert.equal(notice([refusedItem('pneumonoultramicroscopicsilicovolcanoconiosis')]).text, '“pneumonoultramicrosc…” stays on this device: the server refused it');
});

test('an item refused as malformed, its title missing or not text, is counted instead of named', () => {
  for (const title of ['', '   ', undefined, 42, { word: 'gamut' }]) {
    assert.equal(notice([refusedItem(title)]).text, '1 change stays on this device: the server refused it', String(title));
  }
});

test('the pill\'s × calls the dismiss it is given', () => {
  const dismiss = () => {};
  const pill = RefusedChangesPill({ items: [refusedItem('gamut')], onDismiss: dismiss }) as ReactElement<ComponentProps<typeof NoticePill>>;
  assert.equal(pill.type, NoticePill);
  assert.deepEqual(pill.props.actions?.map(action => [action.label, action.dismiss, action.onClick]), [['Dismiss the refused changes notice', true, dismiss]]);
});

// Just enough of a browser for React to mount a component that draws nothing, as in overlays.test.ts, installed only
// while the test below mounts one.
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

test('dismissed, the notice stays away until the server refuses another change, and then tells of them all again', async () => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  let seen: ReturnType<typeof useDismissedUntilNew> | undefined;
  // Each refusal is an item's id and the hash of the content refused.
  const Notice = ({ refusals }: { refusals: string[] }) => {
    seen = useDismissedUntilNew(refusals);
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const show = async (refusals: string[]): Promise<boolean> => {
    await act(() => root.render(createElement(Notice, { refusals })));
    return seen!.shown;
  };
  const dismiss = () => act(() => seen!.dismiss());
  try {
    assert.equal(await show([]), false, 'nothing refused, nothing to tell');
    assert.equal(await show(['a:1']), true);
    await dismiss();
    assert.equal(await show(['a:1']), false, 'the same refusal, at the next push');
    assert.equal(await show(['a:1', 'b:1']), true, 'another item refused');
    await dismiss();
    assert.equal(await show(['a:2', 'b:1']), true, 'an edit of a, refused again');
    await dismiss();
    assert.equal(await show(['a:2']), false, 'b left, edited: nothing new');
    assert.equal(await show([]), false);
  } finally {
    await act(() => root.unmount());
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
