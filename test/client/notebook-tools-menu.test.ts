import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookToolsPanel } from '../../views/notebook/NotebookToolsMenu.tsx';

// views/notebook/NotebookToolsMenu.tsx's panel, the rows the Notebook's ⋯ menu lists, rendered on the server.

const noop = () => {};
type PanelProps = ComponentProps<typeof NotebookToolsPanel>;
const renderPanel = (props: Partial<PanelProps> = {}) => renderToStaticMarkup(createElement(NotebookToolsPanel, {
  offline: false, onAnalyzeText: noop, onBatchImport: noop, onImportJSON: noop, onDownloadOfflineImages: noop, onForceSync: noop,
  syncStatus: 'idle', onGenerateAllSpeech: noop, speechGenerationRunning: false, onRestoreImagesToServer: noop,
  imageRestoreRunning: false, onFindDuplicates: noop, onShowShortcuts: noop, onChosen: noop, ...props,
}));
/** The menu's buttons by their text, with whether each is disabled. */
const menuRows = (html: string) => [...html.matchAll(/<button( disabled="")? class="w-full[^"]*">(.*?)<\/button>/g)]
  .map(match => ({
    label: match[2].replace(/<svg.*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
    disabled: !!match[1],
  }));

test('the menu ends with the gestures and shortcuts sheet, the way to it on a phone', () => {
  const rows = menuRows(renderPanel());
  assert.deepEqual(rows.at(-1), { label: 'Gestures & shortcuts', disabled: false });
  assert.deepEqual(rows.map(row => row.label), [
    'Analyze text', 'Batch import', 'Import JSON', 'Download image pack', 'Sync now', 'Generate speech cache',
    'Restore server images', 'Merge duplicates', 'Gestures & shortcuts',
  ]);
  assert.ok(!menuRows(renderPanel({ onShowShortcuts: undefined })).some(row => row.label === 'Gestures & shortcuts'));
});

test('offline, the tools that need the server stay in place, disabled with the reason; the device\'s own tools work', () => {
  const offline = menuRows(renderPanel({ offline: true }));
  const NEEDS = 'Needs a connection';
  assert.deepEqual(offline, [
    { label: `Analyze text ${NEEDS}`, disabled: true },
    { label: `Batch import ${NEEDS}`, disabled: true },
    { label: `Import JSON ${NEEDS}`, disabled: true },
    { label: `Download image pack ${NEEDS}`, disabled: true },
    { label: `Sync now ${NEEDS}`, disabled: true },
    { label: `Generate speech cache ${NEEDS}`, disabled: true },
    { label: `Restore server images ${NEEDS}`, disabled: true },
    { label: 'Merge duplicates', disabled: false },
    { label: 'Gestures & shortcuts', disabled: false },
  ]);
  // The speech settings above the tools stay too.
  const html = renderPanel({ offline: true });
  assert.ok(html.includes('Speech playback'));
  const settingsRow = html.slice(0, html.indexOf('</div></div>'));
  assert.match(settingsRow, /aria-label="Speech style"/);
  assert.doesNotMatch(settingsRow, /disabled=""/);
  // Online nothing is disabled but a running job.
  assert.ok(menuRows(renderPanel()).every(row => !row.disabled));
  assert.deepEqual(menuRows(renderPanel({ syncStatus: 'syncing' })).filter(row => row.disabled).map(row => row.label), ['Sync now']);
});
