import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { useModalDialog } from '../../components/overlayStack.ts';
import {
  liftNoticesAbovePopup, openDialogs, popupIsEmpty, useOverlays, type CardPopup, type Overlays,
} from '../../hooks/useOverlays.ts';
import type { StoredItem } from '../../types.ts';
import { readRepoFile } from '../support/paths.ts';

// hooks/useOverlays.ts: which dialogs cover the page, when the card popup has nothing left to show, and when the
// notice stack rises above it; and components/Modal, which registers every dialog it shows.

const sense = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
const popup: CardPopup = { spelling: 'gamut', initialId: 's1' };
const closed = {
  cardPopup: null, popupItems: [], modalShowing: false, showKeyboardHelp: false, showRefusedReviews: false, duplicateClusters: null,
};

test('the popup is empty once every sense it showed is gone, and a closed popup never is', () => {
  assert.equal(popupIsEmpty(popup, []), true);
  assert.equal(popupIsEmpty(popup, [sense('s1')]), false);
  assert.equal(popupIsEmpty(null, []), false);
  assert.equal(popupIsEmpty(null, [sense('s1')]), false);
});

test('each decision dialog is modal and covers the page', () => {
  const dialogs = {
    modalShowing: true,
    showKeyboardHelp: true,
    showRefusedReviews: true,
    duplicateClusters: [],
  };
  assert.deepEqual(openDialogs(closed), { modalOpen: false, dialogOpen: false });
  for (const [name, open] of Object.entries(dialogs)) {
    assert.deepEqual(openDialogs({ ...closed, [name]: open }), { modalOpen: true, dialogOpen: true }, name);
  }
});

test('the card popup covers the page while it shows a card, without counting as modal', () => {
  assert.deepEqual(openDialogs({ ...closed, cardPopup: popup, popupItems: [sense('s1')] }), { modalOpen: false, dialogOpen: true });
  assert.deepEqual(openDialogs({ ...closed, cardPopup: popup, popupItems: [] }), { modalOpen: false, dialogOpen: false }, 'nothing left to show');
  assert.deepEqual(
    openDialogs({ ...closed, cardPopup: popup, popupItems: [sense('s1')], showKeyboardHelp: true }),
    { modalOpen: true, dialogOpen: true },
  );
});

test('over the card popup, an undo offer or the couldn\'t-save alert lifts the notices, unless a dialog is open over the popup', () => {
  const quiet = { cardPopup: popup, modalOpen: false, undoOffered: false, writeFailed: false };
  assert.equal(liftNoticesAbovePopup(quiet), false, 'nothing to reach');
  assert.equal(liftNoticesAbovePopup({ ...quiet, undoOffered: true }), true);
  assert.equal(liftNoticesAbovePopup({ ...quiet, writeFailed: true }), true);
  assert.equal(liftNoticesAbovePopup({ ...quiet, undoOffered: true, cardPopup: null }), false, 'no popup to rise above');
  // The shortcut sheet or the refused reviews opened over the popup: the stack stays beneath the dialog.
  assert.equal(liftNoticesAbovePopup({ ...quiet, undoOffered: true, modalOpen: true }), false);
  assert.equal(liftNoticesAbovePopup({ ...quiet, writeFailed: true, modalOpen: true }), false);
});

// Just enough of a browser for React to mount components that draw nothing, as in connectivity-notice.test.ts,
// installed only while the test below mounts them.
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

test('a dialog that registers with useModalDialog counts as modal in useOverlays for as long as one is mounted, wherever it renders', async () => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  const seen: Overlays[] = [];
  // A stand-in for components/Modal, which registers every dialog this way (the test below checks that it does).
  const Dialog = () => { useModalDialog(); return null; };
  const Shell = ({ dialogs }: { dialogs: number }) => {
    seen.push(useOverlays([]));
    return Array.from({ length: dialogs }, (_, index) => createElement(Dialog, { key: index }));
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const show = (dialogs: number) => act(() => root.render(createElement(Shell, { dialogs })));
  const covered = () => {
    const { modalOpen, dialogOpen } = seen[seen.length - 1];
    return { modalOpen, dialogOpen };
  };
  try {
    await show(0);
    assert.deepEqual(covered(), { modalOpen: false, dialogOpen: false });
    await show(2);
    assert.deepEqual(covered(), { modalOpen: true, dialogOpen: true });
    await show(1);
    assert.deepEqual(covered(), { modalOpen: true, dialogOpen: true }, 'one is still open');
    await show(0);
    assert.deepEqual(covered(), { modalOpen: false, dialogOpen: false });
  } finally {
    await act(() => root.unmount());
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('Modal registers every dialog it shows: its component body calls useModalDialog()', () => {
  // The sign-out confirmations (UserMenu's ConfirmModal) and an overlay's crash dialog are Modals App doesn't open: only
  // this call makes them count, so ⌘Z doesn't undo behind them and the search status line doesn't show under them.
  const source = ts.createSourceFile('Modal.tsx', readRepoFile('components/Modal.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modal = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText() === 'Modal')?.initializer;
  assert.ok(modal && ts.isArrowFunction(modal) && ts.isBlock(modal.body), 'Modal is a component with a body');
  const statements = modal.body.statements.filter(ts.isExpressionStatement).map(statement => statement.expression.getText());
  assert.ok(statements.includes('useModalDialog()'), `a statement of the body itself, not inside a condition: ${statements.join('; ')}`);
});
