import assert from 'node:assert/strict';
import test from 'node:test';
import { isMacPlatform, modifierKeyLabel } from '../../services/notebook/platform.ts';

const withNavigator = (value: object, run: () => void) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
};

test('shortcut hints name ⌘ on a Mac or an iPad that reports one, and Ctrl elsewhere', () => {
  withNavigator({ userAgentData: { platform: 'macOS' }, platform: '' }, () => assert.equal(modifierKeyLabel(), '⌘'));
  withNavigator({ platform: 'MacIntel' }, () => assert.equal(modifierKeyLabel(), '⌘'));
  withNavigator({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }, () => assert.equal(modifierKeyLabel(), 'Ctrl'));
  withNavigator({ platform: 'iPhone' }, () => assert.equal(isMacPlatform(), false));
  withNavigator({}, () => assert.equal(modifierKeyLabel(), 'Ctrl'));
});
