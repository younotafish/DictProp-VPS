import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SentenceData } from '../../types.ts';
import { SentenceAnalysisView } from '../../components/SentenceAnalysisView.tsx';

// The sentence's analysis page (components/SentenceAnalysisView.tsx), rendered on the server: its header's Got it.

const sentence: SentenceData = { id: 'sentence-1', text: 'She finally came clean.', sourceWord: 'come clean' };

const page = (props: Partial<ComponentProps<typeof SentenceAnalysisView>> = {}) => renderToStaticMarkup(createElement(SentenceAnalysisView, {
  sentence, position: 2, total: 12, visible: true, onBack: () => {}, onSearch: () => {}, onTouchStart: () => {}, onTouchEnd: () => {},
  ...props,
}));

/** The header's markup, from its opening tag to its close. */
const headerOf = (html: string) => html.match(/<header[\s\S]*?<\/header>/)![0];

test('the analysis header has a compact Got it in its right slot, 76 px wide like the empty slot it fills', () => {
  const header = headerOf(page({ onRemember: () => {} }));
  const button = header.match(/<button[^>]*title="Remember \(R\)"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button, 'a Got it button titled Remember (R)');
  assert.match(button, /<\/svg> Got it<\/button>$/);
  assert.match(button, /lucide-check/);
  const classes = button.match(/class="([^"]*)"/)![1].split(/\s+/);
  for (const name of ['h-9', 'w-[76px]', 'rounded-lg', 'bg-emerald-500', 'text-sm', 'font-bold', 'text-white']) {
    assert.ok(classes.includes(name), name);
  }
  assert.doesNotMatch(header, /aria-hidden="true"><\/div>/, 'the button takes the spacer\'s place');
});

test('a read-only preview keeps the empty 76 px slot, so the title stays where it was', () => {
  const header = headerOf(page());
  assert.doesNotMatch(header, /Got it/);
  assert.match(header, /<div class="w-\[76px\]" aria-hidden="true"><\/div><\/div><\/header>$/);
});

test('Got it stops its click there, so the page behind doesn\'t take it as a tap too', () => {
  let remembered = 0;
  let stopped = 0;
  // The page's element tree as its render returns it, its hooks run by a probe component.
  let tree: unknown;
  const Probe = () => {
    tree = SentenceAnalysisView({
      sentence, position: 1, total: 1, visible: true, onBack: () => {}, onSearch: () => {}, onTouchStart: () => {}, onTouchEnd: () => {},
      onRemember: () => { remembered += 1; },
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const button = findElement(tree, node => node.props?.title === 'Remember (R)');
  assert.ok(button, 'the Got it element');
  (button.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => { stopped += 1; } });
  assert.deepEqual([remembered, stopped], [1, 1]);
});

interface ElementLike { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }

/** The first element in a rendered tree that `match` accepts, walking props.children depth first. */
function findElement(node: unknown, match: (node: ElementLike) => boolean): (ElementLike & { props: Record<string, unknown> }) | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  const element = node as ElementLike;
  if (element.props && match(element)) return element as ElementLike & { props: Record<string, unknown> };
  return findElement(element.props?.children, match);
}
