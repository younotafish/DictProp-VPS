import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignInPanel } from '../../components/AppGateScreens.tsx';
import { nextAuthGate, type AuthGate } from '../../services/auth.ts';
import { signInPrompt } from '../../services/authGate.ts';

// What the sign-in screen says (services/authGate.ts) and when a signed-out screen means the sign-in expired
// (services/auth.ts's nextAuthGate); then the screen itself, rendered on the server.

const EXPIRED = 'Your sign-in expired. Your library and any changes not yet synced are kept on this device. Sign in to pick up where you left off.';
const user = { id: 'u1', email: 'me@example.com', displayName: 'Me', photoUrl: null, isAdmin: true };

test('the sign-in screen says an expiry keeps the library safe, and offline its button waits for a connection', () => {
  assert.deepEqual(signInPrompt({ expired: false, online: true }), { message: null, button: 'Sign in with Google', disabled: false });
  assert.deepEqual(signInPrompt({ expired: true, online: true }), { message: EXPIRED, button: 'Sign in with Google', disabled: false });
  assert.deepEqual(signInPrompt({ expired: false, online: false }), { message: null, button: 'Connect to sign in', disabled: true });
  assert.deepEqual(signInPrompt({ expired: true, online: false }), { message: EXPIRED, button: 'Connect to sign in', disabled: true });
});

test('a session the app had that comes back as none has expired; a first visit, or the same account, has not', () => {
  const cached: AuthGate = { user, loading: false, expired: false };
  assert.equal(nextAuthGate(cached, { ...user }), cached, 'the same account changes nothing');
  assert.deepEqual(nextAuthGate(cached, null), { user: null, loading: false, expired: true }, 'the cached session the server turned away');

  const firstVisit: AuthGate = { user: null, loading: true, expired: false };
  assert.deepEqual(nextAuthGate(firstVisit, null), { user: null, loading: false, expired: false });
  assert.deepEqual(nextAuthGate(firstVisit, user), { user, loading: false, expired: false });

  const expired = nextAuthGate(cached, null);
  assert.equal(nextAuthGate(expired, null), expired, 'still expired on the next check');
  assert.deepEqual(nextAuthGate(expired, user), { user, loading: false, expired: false }, 'until an account returns');
});

const renderPanel = (expired: boolean, online: boolean) =>
  renderToStaticMarkup(createElement(SignInPanel, { expired, online, onSignIn: () => {} }));

test('offline, the sign-in button is disabled and reads Connect to sign in', () => {
  const offline = renderPanel(false, false);
  assert.match(offline, /<button disabled="" class="[^"]*">[\s\S]*<\/svg>Connect to sign in<\/button>/);
  assert.doesNotMatch(offline, /Sign in with Google/);
  const online = renderPanel(false, true);
  assert.match(online, /<button class="[^"]*">[\s\S]*<\/svg>Sign in with Google<\/button>/);
  assert.doesNotMatch(online, /disabled=""/);
});

test('after an expiry the screen says the library is kept, above the button', () => {
  const html = renderPanel(true, true);
  assert.ok(html.includes(`<p class="mx-auto max-w-sm text-sm leading-relaxed text-slate-600">${EXPIRED}</p>`));
  assert.ok(html.indexOf(EXPIRED) < html.indexOf('<button'));
  assert.doesNotMatch(renderPanel(false, true), /expired/);
});
