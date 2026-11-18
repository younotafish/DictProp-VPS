import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { AppStatusPills } from '../../components/AppStatus.tsx';
import { SearchFab } from '../../components/search/SearchFab.tsx';
import { SearchToasts } from '../../components/search/SearchToasts.tsx';
import { SentenceActionsRow } from '../../views/detail/SentenceActionsRow.tsx';
import { SentencePlaybackControls } from '../../views/detail/SentencePlaybackControls.tsx';
import { SentenceImageFab } from '../../views/detail/SentenceImageAttach.tsx';
import { PracticePill } from '../../views/detail/PracticePill.tsx';
import { sentenceRowState } from '../../views/detail/sentenceRowState.ts';
import { arbitraryValue, cssLength, readRootVars } from '../support/cssLength.ts';
import { readRepoFile } from '../support/paths.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// What floats over an open sentence lesson, worked out from the classes that place it, on a laptop (no safe area)
// and on a Face ID iPhone (a 34 px home-indicator strip). From the bottom up the floats form bands that never
// overlap: the lesson row's buttons, the Clear/Casual and auto-play cluster, the notice stack and the search button
// on the card float line, the attach-image button, and the search error toast. The cluster clears the row by 4 px
// and every band above it clears the one below by 8 px; the auto-play panel opens high enough that Stop auto-play
// clears the search button, which draws above the whole card view.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const rootVars = readRootVars(readRepoFile('src/index.css'));
const INSETS = [['laptop', { insetBottom: 0, vw: 1440 }], ['iPhone', { insetBottom: 34, vw: 390 }]] as const;
type Place = (typeof INSETS)[number][1];

const classList = (tag: string) => tag.match(/class="([^"]*)"/)![1].split(/\s+/);
/** The opening tag of the first element in `html` that `pattern` matches. */
const tagOf = (html: string, pattern: RegExp) => {
  const tag = html.match(pattern)?.[0];
  assert.ok(tag, `no element matches ${pattern}`);
  return tag;
};
/** A Tailwind spacing class's length: 0.25rem a step (h-9 is 36 px, -my-1 a 4 px pull). */
const spacing = (classes: string[], utility: string) => {
  const name = classes.find(item => new RegExp(`^-?${utility}-\\d+(\\.\\d+)?$`).test(item));
  assert.ok(name, `a ${utility}- class among ${classes.join(' ')}`);
  return Math.abs(Number(name.slice(name.lastIndexOf('-') + 1))) * 4;
};
const bottomOf = (classes: string[], at: Place) => {
  const value = arbitraryValue(classes, 'bottom');
  assert.ok(value, `a bottom-[…] class among ${classes.join(' ')}`);
  return cssLength(value, { ...at, vars: rootVars });
};

// The lesson row ends the banner, whose bottom padding is read from the view's source: the view itself needs a library.
const bannerClasses = (() => {
  const source = readRepoFile('views/detail/SentenceReviewView.tsx');
  const banner = source.match(/className=\{`(bg-white border-b border-slate-200 px-3 [^`]*)`\}/);
  assert.ok(banner, 'the banner\'s classes in SentenceReviewView.tsx');
  return banner[1].split(/\s+/);
})();

type RowProps = ComponentProps<typeof SentenceActionsRow>;
/**
 * The lesson row as sentence review renders it for a catalog line or a saved sentence, reviewed or not, or an example;
 * on wider screens a saved sentence's row also holds the practice pill.
 */
const lessonRow = (kind: 'catalog' | 'saved' | 'example', reviews: number, practicePill?: RowProps['practicePill']) => {
  const preview = kind === 'example';
  const srs = { ...SRSAlgorithm.createNew('s1', 'sentence', 0), totalReviews: reviews };
  const state = sentenceRowState({ catalog: kind === 'catalog', preview, totalReviews: reviews });
  const mastery = state.showStats ? SRSAlgorithm.getMasteryLevel(srs) : null;
  const props: RowProps = {
    srs, mastery, masteryColors: mastery ? getMasteryColors(mastery.color) : null, memorizedCount: 3, preview,
    catalog: kind === 'catalog', catalogKind: kind === 'catalog' ? 'real-life' : undefined, onRemember: () => {},
    onSaveSentence: () => {}, onReset: state.showReset ? () => {} : undefined, onDelete: () => {}, practicePill,
  };
  return renderToStaticMarkup(createElement(SentenceActionsRow, props));
};

/**
 * The top of the row's buttons above the screen's bottom. The row sits on the banner's padding and is as tall as its
 * tallest child's margin box: a button's height less the pulls of its negative margins, or the memory's 20 px line
 * on the left. A button is centred in it, so its top stands (row + button) / 2 above the row's bottom.
 */
const rowTop = (html: string, at: Place) => {
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map(match => classList(match[0]));
  assert.ok(buttons.length > 0, 'the row has buttons');
  const sizes = buttons.map(classes => ({
    height: classes.some(name => /^min-h-\d/.test(name)) ? spacing(classes, 'min-h') : spacing(classes, 'h'),
    pull: classes.includes('-my-1') ? 4 : 0,
  }));
  const rowHeight = Math.max(20, ...sizes.map(({ height, pull }) => height - 2 * pull));
  const padding = cssLength(arbitraryValue(bannerClasses, 'pb')!, { ...at, vars: rootVars });
  return padding + Math.max(...sizes.map(({ height }) => (rowHeight + height) / 2));
};

const controls = renderToStaticMarkup(createElement(SentencePlaybackControls, {
  onSpeechStyleChange: () => {}, autoPlaying: true, onAutoPlayButton: () => {}, showPanel: true, onClosePanel: () => {},
  countdownStartedAt: null, timerMinutes: 10, onCycleTimer: () => {}, repeats: 2, onCycleRepeats: () => {}, gap: 1500,
  onCycleGap: () => {}, onStop: () => {},
}));
const clusterClasses = classList(tagOf(controls, /^<div[^>]*>/));
const autoPlayButton = classList(tagOf(controls, /<button[^>]*aria-label="Open sentence auto-play settings"[^>]*>/));
const panelClasses = classList(tagOf(controls, /<div role="dialog"[^>]*>/));
const toggleClasses = classList(tagOf(controls, /<div[^>]*role="group"[^>]*>/));
const toggleButton = classList(tagOf(controls, /<button[^>]*aria-pressed[^>]*>/));

const stack = classList(tagOf(renderToStaticMarkup(createElement(AppStatusPills, {
  userId: 'u1', onViewRefusedReviews: () => {}, imagePrefetchProgress: null, onStopImageDownload: () => {}, imageRestoreProgress: null,
  jobPills: null, undoMessage: null, onUndo: () => {}, stuckSyncPill: null, aboveTabBar: false, holdUpdate: false,
  liftAbovePopup: false, writeFailed: false, offline: false, offlineChip: false, refusedChangesNotice: null,
})), /^<div[^>]*>/));
const searchFab = classList(tagOf(renderToStaticMarkup(createElement(SearchFab, {
  unseenCount: 0, readyCount: 0, runningCount: 0, isBusy: false, aboveTabBar: false, onClick: () => {},
})), /^<button[^>]*>/));
const errorToast = classList(tagOf(renderToStaticMarkup(createElement(SearchToasts, {
  saveToast: null, error: { msg: 'Could not analyze "gamut".' }, onRetry: () => {}, onEdit: () => {},
  onDismissError: () => {}, aboveTabBar: false,
})), /<div role="alert"[^>]*>/));
const attachFab = classList(tagOf(renderToStaticMarkup(createElement(SentenceImageFab, { hasImage: false, onTap: () => {} })), /^<button[^>]*>/));

/** Every band's bottom and top above the screen's bottom, at a safe-area inset. */
function bands(at: Place) {
  // The cluster is as tall as the auto-play button; the Clear/Casual toggle beside it (a border, p-0.5, and a py-1
  // text-xs button, 16 px of line) is shorter and centred.
  assert.ok(toggleClasses.includes('border') && toggleButton.includes('text-xs'), 'the toggle\'s border and text size');
  const toggleHeight = 2 + 2 * spacing(toggleClasses, 'p') + 2 * spacing(toggleButton, 'py') + 16;
  const clusterHeight = Math.max(spacing(autoPlayButton, 'h'), toggleHeight);
  const clusterBottom = bottomOf(clusterClasses, at);
  const fabBottom = bottomOf(searchFab, at);
  const attachBottom = bottomOf(attachFab, at);
  return {
    toggleHeight,
    row: { top: rowTop(lessonRow('saved', 3), at) },
    cluster: { bottom: clusterBottom, top: clusterBottom + clusterHeight },
    // The panel hangs from the auto-play button's wrapper, which is the cluster's height and sits on its bottom.
    panel: { bottom: clusterBottom + cssLength(arbitraryValue(panelClasses, 'bottom')!, at) },
    stack: { bottom: bottomOf(stack, at) },
    searchFab: { bottom: fabBottom, top: fabBottom + spacing(searchFab, 'h') },
    attachFab: { bottom: attachBottom, top: attachBottom + spacing(attachFab, 'h') },
    errorToast: { bottom: bottomOf(errorToast, at) },
  };
}

test('the lesson row\'s buttons top out 2rem above the banner\'s padding, which clears the home indicator', () => {
  assert.equal(arbitraryValue(bannerClasses, 'pb'), 'max(0.5rem,env(safe-area-inset-bottom))');
  for (const [, at] of INSETS) {
    const padding = Math.max(8, at.insetBottom);
    for (const [kind, reviews] of [['saved', 0], ['saved', 3], ['catalog', 0], ['catalog', 1], ['example', 0]] as const) {
      assert.equal(rowTop(lessonRow(kind, reviews), at), padding + 32, `${kind} with ${reviews} reviews, inset ${at.insetBottom}`);
    }
  }
});

test('the practice pill beside Got it leaves the lesson row as tall as it was, so the floats above it keep their bands', () => {
  for (const practicing of [false, true]) {
    const practicePill = createElement(PracticePill, {
      toggle: { itemId: 's1', practicing, name: 'She came clean.', noun: 'sentence' }, onPress: () => {},
    });
    for (const [, at] of INSETS) {
      for (const reviews of [0, 3]) {
        assert.match(lessonRow('saved', reviews, practicePill), /to practice|Stop practicing/, 'the row holds the pill');
        assert.equal(rowTop(lessonRow('saved', reviews, practicePill), at), rowTop(lessonRow('saved', reviews), at));
      }
    }
  }
});

test('over a lesson the floats form bands, 4 px from the row to the cluster and 8 px apart above it', () => {
  for (const [device, at] of INSETS) {
    const b = bands(at);
    assert.ok(b.toggleHeight < b.cluster.top - b.cluster.bottom, 'the toggle is shorter than the auto-play button');
    assert.ok(b.cluster.bottom - b.row.top >= 4, `${device}: the cluster clears the row (${b.row.top} → ${b.cluster.bottom})`);
    assert.ok(b.stack.bottom - b.cluster.top >= 8, `${device}: the notices clear the cluster (${b.cluster.top} → ${b.stack.bottom})`);
    assert.equal(b.searchFab.bottom, b.stack.bottom, `${device}: the search button sits on the notices' line`);
    assert.ok(b.attachFab.bottom - b.searchFab.top >= 8, `${device}: the attach button clears the search button`);
    assert.ok(b.errorToast.bottom - b.attachFab.top >= 8, `${device}: the error toast clears the attach button`);
    assert.ok(b.panel.bottom - b.searchFab.top >= 8, `${device}: Stop auto-play clears the search button`);
  }
});

test('the bands land where the plan puts them: 96 px and 122 px card float lines, the cluster 8 px under them', () => {
  const at = (device: 'laptop' | 'iPhone') => bands(INSETS.find(([name]) => name === device)![1]);
  assert.deepEqual(at('laptop'), {
    toggleHeight: 30,
    row: { top: 40 }, cluster: { bottom: 44, top: 88 }, panel: { bottom: 152 }, stack: { bottom: 96 },
    searchFab: { bottom: 96, top: 144 }, attachFab: { bottom: 160, top: 208 }, errorToast: { bottom: 216 },
  });
  assert.deepEqual(at('iPhone'), {
    toggleHeight: 30,
    row: { top: 66 }, cluster: { bottom: 70, top: 114 }, panel: { bottom: 178 }, stack: { bottom: 122 },
    searchFab: { bottom: 122, top: 170 }, attachFab: { bottom: 186, top: 234 }, errorToast: { bottom: 242 },
  });
});
