import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, ChevronUp, Lightbulb, Scale, type LucideIcon } from 'lucide-react';
import { ComparisonBody } from '../../components/ComparisonBody.tsx';
import { sanitizeComparisonResult } from '../../services/api/comparisons.ts';

// Every comparison that reaches the view has been through sanitizeComparisonResult: /api/compare's reply, the server's
// saved list and the device's cached copy. These renders pin the markup the view gives such a comparison.

const render = (comparison: unknown, words: string[]) =>
  renderToStaticMarkup(createElement(ComparisonBody, { result: sanitizeComparisonResult(comparison, words) }));
const icon = (Icon: LucideIcon, size: number, className: string) => renderToStaticMarkup(createElement(Icon, { size, className }));

test('a comparison renders its summary, dimensions, examples, mistakes and verdict, each word in its color', () => {
  const markup = render({
    words: ['fable', 'parable', 'allegory'],
    summary: 'A fable teaches through animals.',
    dimensions: [
      {
        label: 'Characters',
        analysis: 'Who acts in the story.',
        // A word is matched to the comparison's words whatever its case; one outside them takes the first color.
        perWord: { Fable: 'Animals that talk.', PARABLE: 'Ordinary people.', allegory: 'Figures that stand for ideas.', myth: 'Gods.' },
      },
      { label: 'Length', analysis: '', perWord: {} },
    ],
    examples: [{ context: 'Teaching a child', sentences: { fable: 'The fox could not reach the grapes.', Allegory: 'The cave stands for ignorance.' } }],
    commonMistakes: ['Calling every moral story a fable.', 'Treating a parable as literal.'],
    verdict: 'Animals: fable. People: parable. Ideas: allegory.',
  }, ['fable', 'parable', 'allegory']);

  const expanded = icon(ChevronUp, 18, 'text-slate-400');
  assert.equal(markup, [
    '<div class="space-y-4">',
    '<div class="bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-2xl p-5 shadow-lg"><div class="flex items-start gap-3">',
    icon(Lightbulb, 20, 'mt-0.5 shrink-0 opacity-80'),
    '<div><h3 class="font-bold text-base mb-1">Key Difference</h3><p class="text-sm leading-relaxed opacity-95">A fable teaches through animals.</p></div>',
    '</div></div>',

    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">',
    '<button class="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">',
    '<h4 class="font-bold text-slate-800 text-sm">Characters</h4>', expanded,
    '</button>',
    '<div class="px-5 pb-5 pt-0 space-y-3"><p class="text-sm text-slate-600 leading-relaxed">Who acts in the story.</p><div class="space-y-2">',
    '<div class="rounded-xl p-3 bg-indigo-50 border border-indigo-200"><div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-indigo-500"></span><span class="font-bold text-sm text-indigo-700">Fable</span></div><p class="text-sm text-slate-700 leading-relaxed pl-4">Animals that talk.</p></div>',
    '<div class="rounded-xl p-3 bg-emerald-50 border border-emerald-200"><div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="font-bold text-sm text-emerald-700">PARABLE</span></div><p class="text-sm text-slate-700 leading-relaxed pl-4">Ordinary people.</p></div>',
    '<div class="rounded-xl p-3 bg-amber-50 border border-amber-200"><div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-amber-500"></span><span class="font-bold text-sm text-amber-700">allegory</span></div><p class="text-sm text-slate-700 leading-relaxed pl-4">Figures that stand for ideas.</p></div>',
    '<div class="rounded-xl p-3 bg-indigo-50 border border-indigo-200"><div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-indigo-500"></span><span class="font-bold text-sm text-indigo-700">myth</span></div><p class="text-sm text-slate-700 leading-relaxed pl-4">Gods.</p></div>',
    '</div></div>',
    '</div>',

    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">',
    '<button class="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">',
    '<h4 class="font-bold text-slate-800 text-sm">Length</h4>', expanded,
    '</button>',
    '<div class="px-5 pb-5 pt-0 space-y-3"><p class="text-sm text-slate-600 leading-relaxed"></p><div class="space-y-2"></div></div>',
    '</div>',

    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">',
    '<div class="px-5 py-4 border-b border-slate-100"><h4 class="font-bold text-slate-800 text-sm">Contextual Examples</h4></div>',
    '<div class="divide-y divide-slate-100"><div class="px-5 py-4">',
    '<p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Teaching a child</p>',
    '<div class="space-y-2">',
    '<div class="flex items-start gap-2.5"><span class="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-indigo-500"></span><div><span class="font-bold text-xs text-indigo-700">fable</span><p class="text-sm text-slate-700 italic leading-relaxed">&quot;The fox could not reach the grapes.&quot;</p></div></div>',
    '<div class="flex items-start gap-2.5"><span class="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-amber-500"></span><div><span class="font-bold text-xs text-amber-700">Allegory</span><p class="text-sm text-slate-700 italic leading-relaxed">&quot;The cave stands for ignorance.&quot;</p></div></div>',
    '</div>',
    '</div></div>',
    '</div>',

    '<div class="bg-amber-50 rounded-2xl border border-amber-200 overflow-hidden">',
    '<div class="px-5 py-4 border-b border-amber-200/60"><div class="flex items-center gap-2">',
    icon(AlertTriangle, 16, 'text-amber-600'),
    '<h4 class="font-bold text-amber-800 text-sm">Common Mistakes</h4></div></div>',
    '<div class="px-5 py-4 space-y-3">',
    '<div class="flex items-start gap-2.5"><span class="text-amber-500 font-bold text-sm mt-0.5 shrink-0">1.</span><p class="text-sm text-amber-900 leading-relaxed">Calling every moral story a fable.</p></div>',
    '<div class="flex items-start gap-2.5"><span class="text-amber-500 font-bold text-sm mt-0.5 shrink-0">2.</span><p class="text-sm text-amber-900 leading-relaxed">Treating a parable as literal.</p></div>',
    '</div>',
    '</div>',

    '<div class="bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-2xl p-5 shadow-lg"><div class="flex items-start gap-3">',
    icon(Scale, 20, 'mt-0.5 shrink-0 opacity-80'),
    '<div><h3 class="font-bold text-base mb-1">Verdict</h3><p class="text-sm leading-relaxed opacity-95">Animals: fable. People: parable. Ideas: allegory.</p></div>',
    '</div></div>',
    '</div>',
  ].join(''));
});

test('a comparison with nothing to show renders an empty body, and one whose parts were malformed renders what survived', () => {
  assert.equal(render({}, ['fable', 'parable']), '<div class="space-y-4"></div>');

  const markup = render({
    words: ['fable', 7],
    summary: { text: 'dropped' },
    dimensions: [{ label: 'Characters', analysis: 3, perWord: { fable: 'Animals.', parable: ['people'] } }, 'not a dimension'],
    examples: 'none',
    commonMistakes: [{ wrong: true }, '  '],
    verdict: 'Fable.',
  }, ['fable', 'parable']);
  assert.equal(markup, [
    '<div class="space-y-4">',
    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">',
    '<button class="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/50 transition-colors">',
    '<h4 class="font-bold text-slate-800 text-sm">Characters</h4>', icon(ChevronUp, 18, 'text-slate-400'),
    '</button>',
    '<div class="px-5 pb-5 pt-0 space-y-3"><p class="text-sm text-slate-600 leading-relaxed"></p><div class="space-y-2">',
    '<div class="rounded-xl p-3 bg-indigo-50 border border-indigo-200"><div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-indigo-500"></span><span class="font-bold text-sm text-indigo-700">fable</span></div><p class="text-sm text-slate-700 leading-relaxed pl-4">Animals.</p></div>',
    '</div></div>',
    '</div>',
    '<div class="bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-2xl p-5 shadow-lg"><div class="flex items-start gap-3">',
    icon(Scale, 20, 'mt-0.5 shrink-0 opacity-80'),
    '<div><h3 class="font-bold text-base mb-1">Verdict</h3><p class="text-sm leading-relaxed opacity-95">Fable.</p></div>',
    '</div></div>',
    '</div>',
  ].join(''));
});
