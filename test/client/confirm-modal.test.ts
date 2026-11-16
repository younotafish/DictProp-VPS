import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmModal, type ConfirmModalProps } from '../../components/ConfirmModal.tsx';

// components/ConfirmModal.tsx, rendered on the server: each variant's header tone, and a confirm button whose colours
// come from its own classes alone, the ones it has always shown.

type Variant = NonNullable<ConfirmModalProps['variant']>;

const render = (props: Partial<ConfirmModalProps> = {}) => renderToStaticMarkup(createElement(ConfirmModal, {
  title: 'Delete “gamut”?', message: 'Its reviews go with it.', confirmText: 'Delete', onConfirm: () => {}, onCancel: () => {}, ...props,
}));
/** The class lists of the dialog's buttons, by their text or accessible name. */
const buttons = (html: string): Map<string, string[]> => new Map([...html.matchAll(/<button [^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)]
  .map(([tag, classes, text]) => [tag.match(/aria-label="([^"]*)"/)?.[1] ?? text, classes.split(/\s+/)]));
const confirmButton = (variant: Variant) => buttons(render({ variant })).get('Delete')!;

test('a danger\'s confirm button is rose and every other variant\'s indigo, as they have always rendered', () => {
  const rose = ['bg-rose-500', 'hover:bg-rose-600', 'shadow-rose-200'];
  const indigo = ['bg-indigo-600', 'hover:bg-indigo-700', 'shadow-indigo-200'];
  const expected: Record<Variant, string[]> = { danger: rose, warning: indigo, success: indigo, info: indigo };
  for (const [variant, colours] of Object.entries(expected) as [Variant, string[]][]) {
    const classes = confirmButton(variant);
    for (const name of [...colours, 'text-white', 'shadow-lg', 'flex-1', 'border-0']) assert.ok(classes.includes(name), `${variant}: ${name}`);
    // One class per colour property: none left for Tailwind's stylesheet order to settle, as the old variant's did.
    assert.deepEqual(classes.filter(name => /^bg-/.test(name)), [colours[0]], variant);
    assert.deepEqual(classes.filter(name => /^hover:bg-/.test(name)), [colours[1]], variant);
    assert.deepEqual(classes.filter(name => /^shadow-[a-z]+-\d+$/.test(name)), [colours[2]], variant);
  }
});

test('the header keeps each variant\'s tone, and Cancel shows unless the dialog asks only for OK', () => {
  for (const [variant, tone] of [['danger', 'rose'], ['warning', 'amber'], ['success', 'emerald'], ['info', 'indigo']] as const) {
    const html = render({ variant });
    assert.match(html, new RegExp(`<div class="p-4 bg-${tone}-50 border-${tone}-100 border-b flex justify-between items-center">`), variant);
    assert.match(html, new RegExp(`<div class="w-8 h-8 bg-${tone}-100 text-${tone}-500 rounded-full`), variant);
  }
  assert.deepEqual([...buttons(render()).keys()], ['Close confirmation', 'Cancel', 'Delete']);
  assert.deepEqual([...buttons(render({ showCancel: false, confirmText: 'OK' })).keys()], ['Close confirmation', 'OK']);
  assert.match(render(), /role="dialog" aria-modal="true" aria-label="Delete “gamut”\?"/);
});
