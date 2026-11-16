import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserMenu } from '../../components/UserMenu.tsx';
import { clearRefusedReviews, recordRefusedReview } from '../../services/refusedReviews.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// components/UserMenu.tsx, the account menu at the end of the Notebook header, rendered on the server. Its badge
// reads this device's refused-reviews log from localStorage.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const owner = { id: 'u1', email: 'me@example.com', displayName: 'Ji Song', photoUrl: 'https://example.com/me.png', isAdmin: true };
const renderMenu = (props: Partial<ComponentProps<typeof UserMenu>> = {}) => renderToStaticMarkup(createElement(UserMenu, {
  user: owner, onSignOut: async () => false, onViewRefusedReviews: () => {}, offline: false, ...props,
}));
/** The Sign out button's opening tag. */
const signOutButton = (html: string) => html.match(/<button[^>]*aria-label="Sign out"[^>]*>/)![0];

test('online, Sign out is a plain enabled button', () => {
  const button = signOutButton(renderMenu());
  assert.doesNotMatch(button, /disabled=""/);
  assert.match(button, /title="Sign Out"/);
  assert.doesNotMatch(button, /aria-describedby/);
  assert.doesNotMatch(renderMenu(), /Needs a connection/);
});

test('offline, Sign out stays in place, disabled, and says it needs a connection', () => {
  const html = renderMenu({ offline: true });
  const button = signOutButton(html);
  assert.match(button, /disabled=""/);
  assert.match(button, /title="Needs a connection"/);
  const describedBy = button.match(/aria-describedby="([^"]+)"/)![1];
  assert.ok(html.includes(`<span id="${describedBy}" class="sr-only">Needs a connection</span>`));
  assert.doesNotMatch(html, /role="dialog"/, 'no dialog to dismiss');
});

test('the menu shows the account from AuthUser, and a badge for reviews the server refused', t => {
  t.after(() => clearRefusedReviews('u1'));
  const plain = renderMenu();
  assert.match(plain, /<img src="https:\/\/example.com\/me.png" alt="Ji Song"/);
  assert.match(plain, />Ji<\/span>/);
  assert.doesNotMatch(plain, /Reviews the server refused/);
  assert.match(renderMenu({ user: { ...owner, photoUrl: null } }), /lucide-user/, 'no photo: the icon');

  recordRefusedReview('u1', { itemId: 'i1', word: 'gamut', reviewedAt: 1, reason: 'The card isn’t on the server' });
  assert.match(renderMenu(), /aria-label="Reviews the server refused: 1"/);
});
