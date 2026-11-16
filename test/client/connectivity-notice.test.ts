import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.ts';
import {
  NEEDS_CONNECTION, OFFLINE_SETTLE_MS, connectivityNotice, networkRowDisabled, type HeaderControl,
} from '../../services/connectivityNotice.ts';

// services/connectivityNotice.ts, what going offline changes on screen, and hooks/useOnlineStatus.ts, which tells the
// app's chrome when an outage has settled.

const NEEDS_SERVER: HeaderControl[] = ['analyze', 'batch', 'json', 'images', 'sync', 'speech', 'restore', 'compare', 'signout'];
const ON_DEVICE: HeaderControl[] = ['merge', 'shortcuts'];

test('offline, every control that needs the server is disabled, Sign out included; online, none is', () => {
  for (const control of [...NEEDS_SERVER, ...ON_DEVICE]) assert.equal(networkRowDisabled(control, true), false, control);
  for (const control of NEEDS_SERVER) assert.equal(networkRowDisabled(control, false), true, control);
  assert.equal(networkRowDisabled('signout', false), true);
  for (const control of ON_DEVICE) assert.equal(networkRowDisabled(control, false), false, `${control} works on the device`);
  assert.equal(NEEDS_CONNECTION, 'Needs a connection');
});

test('the Offline chip shows once an outage has settled, and only on the tabs', () => {
  assert.equal(connectivityNotice({ offline: false, onTab: true }), 'hidden');
  assert.equal(connectivityNotice({ offline: true, onTab: true }), 'chip');
  assert.equal(connectivityNotice({ offline: true, onTab: false }), 'hidden', 'over an open card or the card popup');
  assert.equal(connectivityNotice({ offline: false, onTab: false }), 'hidden');
});

// Just enough of a browser for React to run the hook: a window that hears online and offline and keeps timers, a page,
// and the connection the browser reports.
let online = true;
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), {
  document: page,
  event: undefined,
  HTMLIFrameElement: class {},
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;
before(() => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online });
});
after(() => {
  delete globals.window;
  delete globals.document;
  delete globals.IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis.navigator as { onLine?: boolean }).onLine;
});

/** useOnlineStatus in a mounted component; `now` is what its last render returned. */
async function mountStatus() {
  const seen: ReturnType<typeof useOnlineStatus>[] = [];
  const Probe = () => {
    seen.push(useOnlineStatus());
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  return { now: () => seen[seen.length - 1], close: () => act(() => root.unmount()) };
}
const goOffline = () => act(() => { online = false; browser.dispatchEvent(new Event('offline')); });
const goOnline = () => act(() => { online = true; browser.dispatchEvent(new Event('online')); });

test('the chrome waits out a brief drop, then treats the app as offline until the connection is back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  online = true;
  const status = await mountStatus();
  assert.deepEqual(status.now(), { isOnline: true, offlineSettled: false });

  await goOffline();
  assert.deepEqual(status.now(), { isOnline: false, offlineSettled: false }, 'an action asked for now sees the drop at once');
  await act(() => t.mock.timers.tick(OFFLINE_SETTLE_MS - 100));
  assert.equal(status.now().offlineSettled, false, 'nothing on screen changes in the first seconds');
  await act(() => t.mock.timers.tick(100));
  assert.equal(status.now().offlineSettled, true, `${OFFLINE_SETTLE_MS} ms in`);

  await goOnline();
  assert.deepEqual(status.now(), { isOnline: true, offlineSettled: false }, 'back at once');

  // A drop shorter than the wait never shows.
  await goOffline();
  await act(() => t.mock.timers.tick(OFFLINE_SETTLE_MS - 1_000));
  await goOnline();
  await act(() => t.mock.timers.tick(10_000));
  assert.equal(status.now().offlineSettled, false);
  await status.close();
});

test('an app opened offline says so at once', async () => {
  online = false;
  const status = await mountStatus();
  assert.deepEqual(status.now(), { isOnline: false, offlineSettled: true });
  await status.close();
});
