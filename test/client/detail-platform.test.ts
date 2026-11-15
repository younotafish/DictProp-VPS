import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform } from '../../views/detail/platform.ts';

const fine = () => false;
const coarse = () => true;

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

test('a Windows laptop is neither, and a coarse pointer alone still draws the touch guides', () => {
  const windows = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 };
  assert.deepEqual(detectPlatform(windows, fine), { isIOS: false, isAndroid: false, isMobile: false, isMacDesktop: false, isTouchCapable: false });
  assert.equal(detectPlatform(windows, coarse).isTouchCapable, true);
});

test('a browser without maxTouchPoints, or no navigator at all, has no touch', () => {
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel' }, fine).isTouchCapable, false);
  assert.equal(detectPlatform(undefined, coarse).isTouchCapable, false);
});
