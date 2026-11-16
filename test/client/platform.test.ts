import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform, isMacPlatform, modifierKeyLabel } from '../../services/platform.ts';
import { isIOS, isMobile } from '../../services/audio/platform.ts';

const fine = () => false;
const coarse = () => true;

const withNavigator = (value: object | undefined, run: () => void) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
};

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test('a Mac laptop gets Command-click and no touch guides', () => {
  const mac = detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }, fine);
  assert.deepEqual(mac, { isIOS: false, isAndroid: false, isMobile: false, isMacDesktop: true, isTouchCapable: false });
});

test('an iPad reporting MacIntel with touch points is iOS, not a Mac desktop', () => {
  const ipad = detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }, fine);
  assert.equal(ipad.isIOS, true);
  assert.equal(ipad.isMobile, true);
  assert.equal(ipad.isMacDesktop, false);
  assert.equal(ipad.isTouchCapable, true);
});

test('iPhones and Android phones are mobile', () => {
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, fine).isIOS, true);
  const android = detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', platform: 'Linux armv8l', maxTouchPoints: 5 }, fine);
  assert.equal(android.isAndroid, true);
  assert.equal(android.isMobile, true);
  assert.equal(android.isMacDesktop, false);
});

test('the device names match in any case, as the speech engine\'s always did', () => {
  const iphone = detectPlatform({ userAgent: 'mozilla/5.0 (iphone; cpu iphone os 18_0 like mac os x)', platform: 'iPhone', maxTouchPoints: 5 }, fine);
  assert.equal(iphone.isIOS, true);
  assert.equal(iphone.isMacDesktop, false);
  const android = detectPlatform({ userAgent: 'mozilla/5.0 (linux; android 14; pixel 8)', platform: 'Linux armv8l', maxTouchPoints: 5 }, fine);
  assert.equal(android.isAndroid, true);
  assert.equal(android.isMobile, true);
});

test('a Windows laptop is neither, and a coarse pointer alone still draws the touch guides', () => {
  const windows = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 };
  assert.deepEqual(detectPlatform(windows, fine), { isIOS: false, isAndroid: false, isMobile: false, isMacDesktop: false, isTouchCapable: false });
  assert.equal(detectPlatform(windows, coarse).isTouchCapable, true);
});

test('a browser without maxTouchPoints, or no navigator at all, has no touch', () => {
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel' }, fine).isTouchCapable, false);
  assert.equal(detectPlatform(undefined, coarse).isTouchCapable, false);
});

test('shortcut hints name ⌘ on a Mac or an iPad that reports one, and Ctrl elsewhere', () => {
  withNavigator({ userAgentData: { platform: 'macOS' }, platform: '' }, () => assert.equal(modifierKeyLabel(), '⌘'));
  withNavigator({ platform: 'MacIntel' }, () => assert.equal(modifierKeyLabel(), '⌘'));
  withNavigator({ platform: 'MacIntel', maxTouchPoints: 5 }, () => assert.equal(isMacPlatform(), true));
  withNavigator({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }, () => assert.equal(modifierKeyLabel(), 'Ctrl'));
  withNavigator({ platform: 'iPhone' }, () => assert.equal(isMacPlatform(), false));
  withNavigator({}, () => assert.equal(modifierKeyLabel(), 'Ctrl'));
});

test('the speech engine asks the same detector, on each call, which devices are iOS and which are mobile', () => {
  const devices: [name: string, nav: { userAgent: string; platform: string; maxTouchPoints?: number }, ios: boolean, mobile: boolean][] = [
    ['iPhone', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 }, true, true],
    ['iPad in desktop-class Safari', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 }, true, true],
    ['iPad Mini UA', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 }, true, true],
    ['iPod touch', { userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, true, true],
    ['Android phone', { userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5 }, false, true],
    ['Mac laptop', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 }, false, false],
    ['Mac with one touch point', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 1 }, false, false],
    ['old Firefox on a Mac', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:115.0) Gecko/20100101 Firefox/115.0', platform: 'MacIntel' }, false, false],
    ['Windows laptop with a touchscreen', { userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10 }, false, false],
  ];
  // The engine's own checks before they asked the detector, kept here to show the answers didn't move.
  const formerIsIOS = (nav: { userAgent: string; platform: string; maxTouchPoints?: number }) =>
    /iPhone|iPad|iPod/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints as number) > 1);
  const formerIsMobile = (nav: { userAgent: string; platform: string; maxTouchPoints?: number }) =>
    /iPhone|iPad|iPod|Android/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints as number) > 1);
  for (const [name, nav, ios, mobile] of devices) {
    withNavigator(nav, () => {
      assert.equal(isIOS(), ios, name);
      assert.equal(isMobile(), mobile, name);
      assert.equal(isIOS(), formerIsIOS(nav), name);
      assert.equal(isMobile(), formerIsMobile(nav), name);
    });
  }
  withNavigator(undefined, () => {
    assert.equal(isIOS(), false);
    assert.equal(isMobile(), false);
  });
});
