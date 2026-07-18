import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnerUser, ownerLoginDecision } from '../src/owner-access.js';

test('owner access allows only the admin identity and fails closed for new databases', () => {
  const owner = { email: 'owner@example.com', is_admin: 1 };
  const other = { email: 'other@example.com', is_admin: 0 };

  assert.equal(isOwnerUser(owner), true);
  assert.equal(isOwnerUser(other), false);
  assert.equal(isOwnerUser(owner, 'OWNER@example.com'), true);
  assert.equal(isOwnerUser(owner, 'other@example.com'), false);

  assert.equal(ownerLoginDecision(owner, owner.email, 2), 'allow');
  assert.equal(ownerLoginDecision(other, other.email, 2), 'deny');
  assert.equal(ownerLoginDecision(null, 'stranger@example.com', 1), 'deny');
  assert.equal(ownerLoginDecision(null, 'owner@example.com', 0), 'deny');
  assert.equal(ownerLoginDecision(null, 'owner@example.com', 0, 'owner@example.com'), 'bootstrap');
  assert.equal(ownerLoginDecision(null, 'stranger@example.com', 0, 'owner@example.com'), 'deny');
});
