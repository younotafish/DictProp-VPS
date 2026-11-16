import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentProps } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';

/** What the boundary calls when it catches `error`: onError, onReset, or neither. */
function callsOnCatch(props: Partial<ComponentProps<typeof ErrorBoundary>>, error: Error): string[] {
  const calls: string[] = [];
  const boundary = new ErrorBoundary({
    children: null, onReset: () => calls.push('onReset'), onError: () => calls.push('onError'), ...props,
  });
  const report = console.error;
  console.error = () => {}; // the boundary reports every error it catches
  try {
    boundary.componentDidCatch(error, { componentStack: '' });
  } finally {
    console.error = report;
  }
  return calls;
}

const renderError = () => new TypeError("Cannot read properties of undefined (reading 'word')");
const chunkLoadError = () => new TypeError('Failed to fetch dynamically imported module: https://dictprop.online/assets/GlobalSearch.js');

test('a caught error reaches onError at once, before anything on the fallback is pressed, whatever the variant', () => {
  for (const variant of ['overlay', 'screen', 'inline', 'fullscreen', undefined] as const) {
    assert.deepEqual(callsOnCatch({ variant }, renderError()), ['onError'], String(variant));
  }
  assert.deepEqual(callsOnCatch({ variant: 'overlay', onError: undefined }, renderError()), [], 'onError is optional');
});

test("a popup whose code couldn't be fetched closes at once instead, keeping what its reload brings back", () => {
  assert.deepEqual(callsOnCatch({ variant: 'overlay' }, chunkLoadError()), ['onReset']);
  assert.deepEqual(callsOnCatch({ variant: 'screen' }, chunkLoadError()), ['onError'], 'a screen shows its fallback for it');
});
