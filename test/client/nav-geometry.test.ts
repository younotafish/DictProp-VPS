import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AppNavigation from '../../components/AppNavigation.tsx';
import { AppStatusPills } from '../../components/AppStatus.tsx';
import { KeyboardHelpModal } from '../../components/KeyboardHelpModal.tsx';
import { NoticePill } from '../../components/NoticePill.tsx';
import { SearchFab } from '../../components/search/SearchFab.tsx';
import { SearchToasts } from '../../components/search/SearchToasts.tsx';
import { TAB_FOOTER_HEIGHT } from '../../components/study/StudyCard.tsx';
import { arbitraryValue, cssLength, readRootVars } from '../support/cssLength.ts';
import { readRepoFile } from '../support/paths.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// The tab bar's height lives twice: in components/AppNavigation.tsx's classes, and in src/index.css's --nav-h, which
// the notice stack and the search button float above. These tests work the bar's height out of its rendered classes and
// hold the variable to it, on a laptop (no safe area) and on a Face ID iPhone (a 34 px home-indicator strip), then
// check what floats above it.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const LAPTOP = { insetBottom: 0, vw: 1440 };
const IPHONE = { insetBottom: 34, vw: 390 };
const rootVars = readRootVars(readRepoFile('src/index.css'));

test('cssLength reads the lengths Tailwind and the stylesheet write', () => {
  const at = { ...IPHONE, vars: { '--a': '1rem', '--b': 'calc(var(--a) * 2)' } };
  assert.equal(cssLength('12px', at), 12);
  assert.equal(cssLength('1.5rem', at), 24);
  assert.equal(cssLength('100vw', at), 390);
  assert.equal(cssLength('calc(100vw-9rem)', at), 246, 'Tailwind writes calc() without spaces');
  assert.equal(cssLength('calc(1rem_+_2px)', at), 18, 'and an underscore for a space');
  assert.equal(cssLength('max(1.5rem,env(safe-area-inset-bottom))', at), 34);
  assert.equal(cssLength('max(1.5rem,env(safe-area-inset-bottom))', { ...at, insetBottom: 0 }), 24);
  assert.equal(cssLength('min(4px,2px)', at), 2);
  assert.equal(cssLength('clamp(1px,5px,3px)', at), 3);
  assert.equal(cssLength('calc(-0.5rem+var(--b))', at), 24);
  assert.equal(cssLength('var(--missing,calc(2px*3))', at), 6, 'the fallback, for a variable nothing sets');
  assert.equal(cssLength('calc(10px/2)', at), 5);
});

test('cssLength refuses what it cannot read, and stylesheet values the browser would drop', () => {
  for (const unreadable of ['10em', 'env(safe-area-inset-top)', 'var(--missing)', 'calc(1px*2px)', 'calc(1px+2)', 'fit-content(1px)', '2', 'calc(1px', '1px)']) {
    assert.throws(() => cssLength(unreadable, LAPTOP), /cssLength/, unreadable);
  }
  assert.throws(() => cssLength('var(--tight)', { ...LAPTOP, vars: { '--tight': 'calc(1px+2px)' } }), /needs a space on each side/);
  assert.equal(cssLength('var(--spaced)', { ...LAPTOP, vars: { '--spaced': 'calc(1px + 2px)' } }), 3);
  assert.equal(arbitraryValue('px-2 pb-[max(1rem,2px)] pt-1', 'pb'), 'max(1rem,2px)');
  assert.equal(arbitraryValue(['pt-1'], 'pb'), null);
});

type NavProps = ComponentProps<typeof AppNavigation>;
const nav: NavProps = { currentView: 'notebook', onNavigate: () => {}, sentenceDueCount: 3, items: [], onKeyboardHelp: () => {}, covered: false, onFocus: () => {} };
const classOf = (html: string, tag: string) => html.match(new RegExp(`<${tag}[^>]*? class="([^"]*)"`))![1].split(/\s+/);
/** A Tailwind spacing class's length: 0.25rem a step (pt-1 is 4px). */
const spacing = (classes: string[], utility: string) => {
  const name = classes.find(item => new RegExp(`^${utility}-\\d+(\\.\\d+)?$`).test(item));
  assert.ok(name, `a ${utility}- class among ${classes.join(' ')}`);
  return Number(name.slice(utility.length + 1)) * 4;
};

/** The bar's height as its classes build it: top padding, a button, bottom padding. */
function barHeight(at: { insetBottom: number; vw: number }): number {
  const html = renderToStaticMarkup(createElement(AppNavigation, nav));
  const bar = classOf(html, 'nav');
  const button = classOf(html, 'button');
  const icon = Number(html.match(/<svg[^>]*? height="(\d+)"/)![1]);
  const label = html.match(/<span class="([^"]*)">Notebook<\/span>/)![1].split(/\s+/);
  const labelPx = Number(arbitraryValue(label, 'text')!.replace('px', ''));
  // The label sets no leading of its own, so it has the page's line-height, 1.5.
  assert.ok(!label.some(item => item.startsWith('leading-')), 'the label keeps the page\'s line-height');
  const buttonHeight = 2 * spacing(button, 'py') + icon + spacing(button, 'gap') + labelPx * 1.5;
  assert.equal(buttonHeight, 67, 'py-3, a 24px icon, gap-1 and a 10px label, as src/index.css says');
  return spacing(bar, 'pt') + buttonHeight + cssLength(arbitraryValue(bar, 'pb')!, at);
}

test('--nav-h is the tab bar\'s height: 95 px on a laptop, 105 px on a Face ID iPhone', () => {
  assert.equal(rootVars['--nav-h'], 'calc(71px + max(1.5rem, env(safe-area-inset-bottom)))');
  for (const [at, height] of [[LAPTOP, 95], [IPHONE, 105]] as const) {
    assert.equal(barHeight(at), height);
    assert.equal(cssLength('var(--nav-h)', { ...at, vars: rootVars }), height);
  }
});

test('a screen reader hears the Sentences badge as the sentences to review, never-reviewed ones included', () => {
  const html = renderToStaticMarkup(createElement(AppNavigation, nav));
  assert.match(html, /aria-label="Sentences, 3 to review"/);
  assert.doesNotMatch(html, / due"/);
});

test('the bar\'s ? button is named for the sheet it opens, Gestures & shortcuts, and its tooltip names the key too', () => {
  // The bar's last button, after the five tabs.
  const button = [...renderToStaticMarkup(createElement(AppNavigation, nav)).matchAll(/<button [^>]*>/g)].map(tag => tag[0])[5];
  const sheet = renderToStaticMarkup(createElement(KeyboardHelpModal, { onClose: () => {}, touchFirst: false, isMac: true }));
  const sheetName = sheet.match(/role="dialog" aria-modal="true" aria-label="([^"]*)"/)![1];
  assert.equal(sheetName, 'Gestures &amp; shortcuts');
  assert.match(button, new RegExp(`aria-label="${sheetName}"`));
  assert.match(button, new RegExp(`title="${sheetName} \\(\\?\\)"`));
  assert.doesNotMatch(button, /Keyboard shortcuts/);
});

type StackProps = ComponentProps<typeof AppStatusPills>;
const stack = (props: Partial<StackProps>) => classOf(renderToStaticMarkup(createElement(AppStatusPills, {
  userId: 'u1', onViewRefusedReviews: () => {}, imagePrefetchProgress: null, onStopImageDownload: () => {}, imageRestoreProgress: null,
  jobPills: null, undoMessage: null, onUndo: () => {}, stuckSyncPill: null, writeFailed: false, offline: false,
  offlineChip: false, refusedChangesNotice: null, aboveTabBar: true, holdUpdate: false, liftAbovePopup: false, ...props,
})), 'div');

test('on the tabs the notice stack floats 8 px above the bar, and above a tab\'s footer', () => {
  const bottom = arbitraryValue(stack({ aboveTabBar: true }), 'bottom')!;
  for (const [at, height] of [[LAPTOP, 95], [IPHONE, 105]] as const) {
    assert.equal(cssLength(bottom, { ...at, vars: rootVars }), height + 8);
    assert.equal(cssLength(bottom, { ...at, vars: { ...rootVars, '--tab-footer-h': '64px' } }), height + 8 + 64, 'Study\'s grade row');
  }
});

test('over a card the notice stack starts at --card-float-bottom: 96 px on a laptop, 122 px on a Face ID iPhone', () => {
  assert.equal(rootVars['--card-float-bottom'], 'max(6rem, calc(env(safe-area-inset-bottom) + 5.5rem))');
  const bottom = arbitraryValue(stack({ aboveTabBar: false }), 'bottom');
  assert.equal(bottom, 'var(--card-float-bottom)');
  assert.equal(cssLength(bottom!, { ...LAPTOP, vars: rootVars }), 96);
  assert.equal(cssLength(bottom!, { ...IPHONE, vars: rootVars }), 122);
});

// The tab bands: on the tabs the search button floats beside the notice stack, at the same height, and its error toast
// above it. Each length comes from the rendered classes, with Study's grade footer (--tab-footer-h) and without.
const fabClasses = () => renderToStaticMarkup(createElement(SearchFab, {
  unseenCount: 0, readyCount: 0, runningCount: 0, isBusy: false, aboveTabBar: true, onClick: () => {},
})).match(/<button[^>]*? class="([^"]*)"/)![1].split(/\s+/).filter(Boolean);
const errorToastClasses = () => classOf(renderToStaticMarkup(createElement(SearchToasts, {
  saveToast: null, error: { msg: 'Couldn’t look that up' }, onRetry: () => {}, onEdit: () => {}, onDismissError: () => {}, aboveTabBar: true,
})), 'div');
const TAB_PLACES = [
  ['a laptop', { insetBottom: 0, vw: 1440 }],
  ['a Face ID iPhone', { insetBottom: 34, vw: 390 }],
] as const;
const FOOTERS = [['no footer', {}], ['Study\'s grade footer', { '--tab-footer-h': TAB_FOOTER_HEIGHT }]] as const;

test('on the tabs the search button sits level with the notice stack, and its error toast clears it by 8 px', () => {
  const fab = fabClasses();
  const fabBottom = arbitraryValue(fab, 'bottom')!;
  const stackBottom = arbitraryValue(stack({ aboveTabBar: true }), 'bottom')!;
  const toastBottom = arbitraryValue(errorToastClasses(), 'bottom')!;
  for (const [place, at] of TAB_PLACES) {
    for (const [footer, vars] of FOOTERS) {
      const context = { ...at, vars: { ...rootVars, ...vars } };
      const where = `${place}, ${footer}`;
      const fabAt = cssLength(fabBottom, context);
      assert.equal(fabAt, cssLength(stackBottom, context), where);
      assert.ok(cssLength(toastBottom, context) >= fabAt + spacing(fab, 'h') + 8, where);
    }
  }
});

test('on a phone the notice pills end at least 8 px short of the search button\'s column', () => {
  const fab = fabClasses();
  const pill = classOf(renderToStaticMarkup(createElement(NoticePill, { tone: 'dark', children: 'Deleted “gamut”' })), 'div');
  const cap = arbitraryValue(pill, 'max-w')!;
  assert.equal(cap, 'calc(100vw-9rem)');
  const stackClasses = stack({ aboveTabBar: true });
  for (const centred of ['left-1/2', '-translate-x-1/2']) assert.ok(stackClasses.includes(centred), centred);
  for (const vw of [375, 390]) {
    const at = { insetBottom: 34, vw };
    // The stack is centred, so its widest pill ends half its cap right of the middle.
    const pillRight = vw / 2 + cssLength(cap, at) / 2;
    const fabLeft = vw - spacing(fab, 'right') - spacing(fab, 'w');
    assert.ok(fabLeft - pillRight >= 8, `${vw} px: the pill ends at ${pillRight}, the button starts at ${fabLeft}`);
  }
});
