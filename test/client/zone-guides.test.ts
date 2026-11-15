import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZoneGuides } from '../../components/review/ZoneGuides.tsx';

const render = (...args: Parameters<typeof ZoneGuides>) => renderToStaticMarkup(createElement(ZoneGuides, ...args));
const marker = (side: string, tone: string, label: number) =>
  `<span class="absolute ${side} top-1/2 -translate-y-1/2 w-5 h-5 rounded-full ${tone} text-[11px] font-bold flex items-center justify-center shadow-sm">${label}</span>`;

// The markup the review popup wrote out by hand for each layout, before the guides became one component.
test('the phone guides keep the card-edge bars, markers and flash the popup had', () => {
  assert.equal(render({ layout: 'phone', bands: 2, flash: { zone: 0, n: 3 } }), [
    '<div class="absolute inset-0 pointer-events-none sm:hidden" aria-hidden="true">',
    '<div class="absolute inset-x-0 top-0 h-1/4">',
    '<div class="absolute left-0 inset-y-2 w-1 rounded-full bg-indigo-400/60"></div>',
    '<div class="absolute right-0 inset-y-2 w-1 rounded-full bg-indigo-400/60"></div>',
    marker('left-1.5', 'bg-indigo-100 text-indigo-600', 1),
    marker('right-1.5', 'bg-indigo-100 text-indigo-600', 1),
    '<div class="absolute left-0 inset-y-0 w-[28%] bg-indigo-400/15 zone-flash"></div>',
    '<div class="absolute right-0 inset-y-0 w-[28%] bg-indigo-400/15 zone-flash"></div>',
    '</div>',
    '<div class="absolute inset-x-0 top-1/4 h-1/4">',
    '<div class="absolute left-0 inset-y-2 w-1 rounded-full bg-emerald-400/60"></div>',
    '<div class="absolute right-0 inset-y-2 w-1 rounded-full bg-emerald-400/60"></div>',
    marker('left-1.5', 'bg-emerald-100 text-emerald-600', 2),
    marker('right-1.5', 'bg-emerald-100 text-emerald-600', 2),
    '</div>',
    '</div>',
  ].join(''));
});

test('the gutter guides keep the screen-quarter bars, markers and flash the popup had', () => {
  assert.equal(render({ layout: 'gutter', bands: 2, flash: { zone: 1, n: 7 } }), [
    '<div class="fixed inset-0 z-[101] pointer-events-none hidden sm:block" aria-hidden="true">',
    '<div class="absolute inset-x-0 top-0 h-[25vh]">',
    '<div class="absolute left-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70"></div>',
    '<div class="absolute right-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70"></div>',
    marker('left-2', 'bg-indigo-100 text-indigo-600', 1),
    marker('right-2', 'bg-indigo-100 text-indigo-600', 1),
    '</div>',
    '<div class="absolute inset-x-0 top-[25vh] h-[25vh]">',
    '<div class="absolute left-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70"></div>',
    '<div class="absolute right-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70"></div>',
    marker('left-2', 'bg-emerald-100 text-emerald-600', 2),
    marker('right-2', 'bg-emerald-100 text-emerald-600', 2),
    '<div class="absolute left-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash"></div>',
    '<div class="absolute right-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash"></div>',
    '</div>',
    '</div>',
  ].join(''));
});

test('a card with one example shows only the first band', () => {
  const html = render({ layout: 'gutter', bands: 1, flash: null });
  assert.match(html, /top-0 h-\[25vh\]/);
  assert.doesNotMatch(html, /top-\[25vh\]|emerald|zone-flash/);
});
