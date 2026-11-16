import assert from 'node:assert/strict';
import test from 'node:test';
import { RENEW_BELOW_MS, renewedExpiry, SESSION_CAP_MS, SESSION_LIFETIME_MS } from '../src/session-renewal.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 15, 12);

/** A session signed in `days` ago and not renewed since: its creation time and expiry. */
const signedInDaysAgo = (days: number) => ({ createdAt: now - days * DAY, expiresAt: now - days * DAY + 30 * DAY });

test('a sign-in lasts 30 days, renews once fewer than 23 are left, and lasts at most 180 days', () => {
  assert.equal(SESSION_LIFETIME_MS, 30 * DAY);
  assert.equal(RENEW_BELOW_MS, 23 * DAY);
  assert.equal(SESSION_CAP_MS, 180 * DAY);
});

test('a session with fewer than 23 days left renews to 30 days from now', () => {
  const eightDaysOld = signedInDaysAgo(8);
  assert.equal(renewedExpiry(eightDaysOld.expiresAt, eightDaysOld.createdAt, now), now + 30 * DAY);
  // A moment under 23 days left renews; exactly 23 days doesn't yet.
  assert.equal(renewedExpiry(now + 23 * DAY - 1, now - 7 * DAY, now), now + 30 * DAY);
  assert.equal(renewedExpiry(now + 23 * DAY, now - 7 * DAY, now), null);
});

test('a session with 23 days or more left is left alone', () => {
  const twoDaysOld = signedInDaysAgo(2);
  assert.equal(renewedExpiry(twoDaysOld.expiresAt, twoDaysOld.createdAt, now), null);
});

test('an expired session never comes back', () => {
  assert.equal(renewedExpiry(now, now - 30 * DAY, now), null);
  assert.equal(renewedExpiry(now - 1, now - 30 * DAY, now), null);
});

test('a renewal reaches no further than 180 days after the sign-in, and a session at that cap stays put', () => {
  const createdAt = now - 170 * DAY;
  assert.equal(renewedExpiry(now + 5 * DAY, createdAt, now), createdAt + 180 * DAY);
  assert.equal(renewedExpiry(createdAt + 180 * DAY, createdAt, now), null);
});

test('a session used every hour renews about once a week and ends 180 days after the sign-in', () => {
  const createdAt = now;
  let expiresAt = createdAt + SESSION_LIFETIME_MS;
  const renewals: number[] = [];
  for (let at = createdAt; at < expiresAt; at += HOUR) {
    const next = renewedExpiry(expiresAt, createdAt, at);
    if (next === null) continue;
    renewals.push(at);
    expiresAt = next;
  }
  assert.equal(expiresAt, createdAt + SESSION_CAP_MS);
  assert.ok(renewals[0] - createdAt > 7 * DAY);
  for (let index = 1; index < renewals.length; index++) assert.ok(renewals[index] - renewals[index - 1] > 7 * DAY);
});
